import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { runPriceIncreaseAlerts } from '@/lib/alerts/engine';
import { detectRecurringCharges, type RecurringCharge } from '@/lib/subscriptions';
import { loadUsdRates } from '@/lib/fx';
import { addDays, today } from '@/lib/dates';
import { formatMoney, formatPercent } from '@/lib/money';
import type { AlertRule, NotificationRow, Transaction } from '@/lib/types';

/**
 * Spec section 8 price-increase alerts, against the live ledger.
 *
 * DELIVERS REAL MESSAGES, so it is gated behind PRICE_ALERT_E2E=1.
 *
 * The first version of this file passed every assertion while the code had
 * never fired once: the live data holds one price rise, Uber at 17%, and 17%
 * of a $6 fare is $26 a year — correctly below the $50 floor. Three green
 * tests, zero lines of the delivery path exercised.
 *
 * So this version does two things instead. It prints every candidate and which
 * floor rejected it, and it temporarily lowers the rule's own thresholds to
 * force a real send — which also proves those two threshold columns actually
 * control the behaviour the owner is told to tune on /alerts.
 *
 *   PRICE_ALERT_E2E=1 npx vitest run tests/price-increase-alerts.integration.test.ts
 */
const ENABLED =
  process.env.PRICE_ALERT_E2E === '1' &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

describe.skipIf(!ENABLED)('price-increase alerts (delivers real messages)', () => {
  let db: SupabaseClient;
  let rule: AlertRule;
  let risen: RecurringCharge[];
  const asOf = today();

  /** The extra annual cost of a rise, both amounts annualised on one cadence. */
  function annualIncrease(c: RecurringCharge): number {
    if (c.previousAmountUsdMinor === null || c.currentAmountUsdMinor === 0) return 0;
    const perYear = c.annualisedUsdMinor / c.currentAmountUsdMinor;
    return Math.round((c.currentAmountUsdMinor - c.previousAmountUsdMinor) * perYear);
  }

  beforeAll(async () => {
    db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const { data } = await db.from('alert_rules').select('*').eq('type', 'price_increase').single();
    rule = data as AlertRule;

    const { data: txns } = await db
      .from('transactions')
      .select('*, counterparty:counterparties(id,name,type)')
      .eq('direction', 'outflow')
      .gte('txn_date', addDays(asOf, -1_100))
      .limit(20_000);
    const rates = await loadUsdRates(db, asOf);
    risen = detectRecurringCharges((txns ?? []) as Transaction[], { asOf, rates }).filter(
      (c) => c.priceChange !== null && c.priceChange > 0,
    );
  }, 30_000);

  afterAll(async () => {
    // Always put the owner's thresholds back, even if an assertion failed.
    if (db && rule) {
      await db
        .from('alert_rules')
        .update({
          threshold_number: rule.threshold_number,
          threshold_minor: rule.threshold_minor,
        })
        .eq('id', rule.id);
    }
  });

  it('has a rule with both floors set', () => {
    // Either floor alone lets through a class of alert nobody wants: a large
    // percentage of a trivial amount, or a trivial percentage of a large one.
    expect(rule).toBeTruthy();
    expect(rule.threshold_number).not.toBeNull();
    expect(rule.threshold_minor).not.toBeNull();
    console.log(
      `\n  rule: at least ${Number(rule.threshold_number) * 100}% AND ` +
        `${formatMoney(rule.threshold_minor ?? 0)}/yr · ${rule.severity} · ` +
        `${rule.channels.join(', ')}`,
    );
  });

  it('shows every price rise and which floor each one cleared', () => {
    const minRise = Number(rule.threshold_number);
    const minAnnual = rule.threshold_minor ?? 0;

    console.log(`\n  ${risen.length} price rise(s) in the ledger:`);
    for (const c of risen) {
      const extra = annualIncrease(c);
      const passRise = (c.priceChange ?? 0) >= minRise;
      const passCost = extra >= minAnnual;
      console.log(
        `  ${passRise && passCost ? 'ALERT ' : 'quiet '} ${c.vendorName.slice(0, 26).padEnd(28)}` +
          `${formatPercent(c.priceChange, 0).padStart(7)}  ${formatMoney(extra).padStart(10)}/yr` +
          `  ${passRise ? 'rise ok' : 'rise below floor'}, ${passCost ? 'cost ok' : 'cost below floor'}`,
      );
    }
    expect(Array.isArray(risen)).toBe(true);
  });

  it('sends when a rise clears both floors, and stays silent on a second run', async () => {
    // Drop the floors to the bottom so whatever the ledger holds gets through.
    // This exercises the delivery path AND proves the two threshold columns are
    // what decides it — the owner is told to tune them, so they have to work.
    await db
      .from('alert_rules')
      .update({ threshold_number: 0.01, threshold_minor: 1 })
      .eq('id', rule.id);

    const first = await runPriceIncreaseAlerts(db, { asOf });
    console.log(
      `\n  floors lowered · first run: ${first.notificationsSent} sent, ` +
        `${first.notificationsSkipped} skipped, ${first.notificationsFailed} failed`,
    );
    for (const e of first.errors) console.log(`    ! ${e}`);

    if (risen.length > 0) {
      // With the floors at the bottom, a ledger containing a rise must alert.
      // Anything else means the path is broken, not that nothing qualified.
      expect(first.notificationsSent + first.notificationsSkipped).toBeGreaterThan(0);
    }

    // The property that decides whether anyone keeps reading the channel. A
    // rise that re-announces itself every day for as long as the vendor keeps
    // billing the new price is how a channel turns into noise.
    const second = await runPriceIncreaseAlerts(db, { asOf });
    console.log(`  second run: ${second.notificationsSent} sent`);
    expect(second.notificationsSent).toBe(0);
  }, 90_000);

  it('records a dedupe key on every notification it delivered', async () => {
    const { data } = await db
      .from('notifications')
      .select('*')
      .eq('alert_rule_id', rule.id)
      .eq('status', 'sent');

    const rows = (data ?? []) as NotificationRow[];
    for (const n of rows) {
      const context = n.context as { priceChangeKey?: string } | null;
      // Without this key the second run cannot tell what it has already said,
      // and every run starts announcing from the beginning again.
      expect(context?.priceChangeKey, `"${n.title}" carries no dedupe key`).toBeTruthy();
      expect(context!.priceChangeKey).toContain('@');
    }
    console.log(`  ${rows.length} delivered notification(s), all carrying a dedupe key\n`);
  });
});
