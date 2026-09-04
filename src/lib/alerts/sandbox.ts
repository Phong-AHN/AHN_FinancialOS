import type { SourceSystem } from '@/lib/types';
import { qboEnvironment } from '@/lib/connectors/quickbooks';
import { plaidEnvironment } from '@/lib/connectors/plaid';

/**
 * Which sources are not real money yet.
 *
 * WHY THIS EXISTS. QuickBooks' sandbox company ships with 31 invoices, most of
 * them long overdue and none of them ever going to be paid. Importing them
 * (decision 85) put 46 obligations in the table, the overdue rule did exactly
 * what it was built to do, and **twelve Slack messages went to AHN's workspace
 * about invoices that do not exist** — with more arriving each day as the fake
 * receivables aged.
 *
 * The rule was not wrong and the import was not wrong. What was missing is that
 * nothing in the alert path asked whether the money was real.
 *
 * A CEO paged about a sandbox invoice learns to ignore the channel, and the
 * channel is the product. So alerts skip rows from an integration that is
 * pointed at a test environment — and the moment `QBO_ENVIRONMENT` becomes
 * `production`, they start flowing again with no code change.
 *
 * DELIBERATELY NOT A ROW FILTER ANYWHERE ELSE. The ledger keeps every sandbox
 * transaction, every page still shows them, and `/integrations` already says in
 * plain words that the figures are sandbox. Hiding them would be a different
 * and worse lie than alerting on them. This only decides who gets woken up.
 */
export function sandboxSources(): Set<SourceSystem> {
  const sandboxed = new Set<SourceSystem>();

  if (qboEnvironment().environment === 'sandbox') sandboxed.add('quickbooks');
  if (plaidEnvironment().environment === 'sandbox') sandboxed.add('plaid');

  /*
   * Stripe is judged by its key, not by a variable.
   *
   * Stripe has no environment setting: `sk_test_…` IS the test environment.
   * Reading the prefix is the only signal there is, and it is a reliable one —
   * Stripe will not accept a test key against live data or the reverse.
   */
  const stripeKey = process.env.STRIPE_SECRET_KEY ?? '';
  if (stripeKey.startsWith('sk_test_')) sandboxed.add('stripe');

  return sandboxed;
}

/**
 * Should this row be allowed to wake somebody up?
 *
 * A row with no source at all is treated as real: hand-entered money is money,
 * and silence is the wrong default for anything a person typed deliberately.
 */
export function alertable(
  row: { source_system?: SourceSystem | null },
  sandboxed: Set<SourceSystem> = sandboxSources(),
): boolean {
  if (!row.source_system) return true;
  return !sandboxed.has(row.source_system);
}

/** For a summary line: "quickbooks, plaid" or null when everything is live. */
export function describeSandboxed(sandboxed: Set<SourceSystem> = sandboxSources()): string | null {
  return sandboxed.size === 0 ? null : [...sandboxed].sort().join(', ');
}
