import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySlackRequest, MAX_REQUEST_AGE_SECONDS } from '@/lib/slack/verify';
import {
  COMMAND_CAPABILITY,
  DEFAULT_SPEND_DAYS,
  forbiddenReply,
  formatBreakEven,
  formatBurn,
  formatCash,
  formatRunway,
  formatSpend,
  formatUnusual,
  helpText,
  parseCommand,
  unlinkedReply,
} from '@/lib/slack/commands';
import { can } from '@/lib/capabilities';
import type { FinancialSnapshot } from '@/lib/calc/engine';
import type { Anomaly, CashChange } from '@/lib/calc/explain';
import type { Transaction, UserRole } from '@/lib/types';

const SECRET = 'test-signing-secret';
const NOW = new Date('2026-09-02T10:00:00Z');

function sign(body: string, timestamp: number, secret = SECRET) {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
}

describe('verifySlackRequest', () => {
  const body = 'command=%2Fahn&text=cash&user_id=U123';
  const ts = Math.floor(NOW.getTime() / 1000);

  it('accepts a request Slack really signed', () => {
    const r = verifySlackRequest(
      body,
      { signature: sign(body, ts), timestamp: String(ts) },
      { signingSecret: SECRET, now: NOW },
    );
    expect(r.ok).toBe(true);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('refuses to run at all when no signing secret is configured', () => {
    // An endpoint that answers questions about the company's money must refuse
    // before it runs unauthenticated — the stance authorizeCron takes.
    //
    // The environment has to be stubbed rather than passing `undefined`: the
    // option falls back to process.env, so an explicit undefined cannot express
    // "nothing is configured". Written the other way this test passed only
    // while the developer's own .env.local happened to lack the key, and went
    // red the moment it was added — which is how it was found.
    vi.stubEnv('SLACK_SIGNING_SECRET', '');
    const r = verifySlackRequest(body, {
      signature: sign(body, ts),
      timestamp: String(ts),
    });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe('not-configured');
  });

  it('rejects a signature made with a different secret', () => {
    const r = verifySlackRequest(
      body,
      { signature: sign(body, ts, 'someone-elses-secret'), timestamp: String(ts) },
      { signingSecret: SECRET, now: NOW },
    );
    expect(r.failure).toBe('bad-signature');
  });

  it('rejects a body that changed after it was signed', () => {
    // The attack this stops: capture a signed `/ahn help` and edit it to
    // `/ahn cash`.
    const tampered = body.replace('text=cash', 'text=runway');
    const r = verifySlackRequest(
      tampered,
      { signature: sign(body, ts), timestamp: String(ts) },
      { signingSecret: SECRET, now: NOW },
    );
    expect(r.failure).toBe('bad-signature');
  });

  it('rejects a replayed request, however valid its signature', () => {
    // A captured request is otherwise replayable forever, and each replay
    // returns today's live figures.
    const old = ts - MAX_REQUEST_AGE_SECONDS - 1;
    const r = verifySlackRequest(
      body,
      { signature: sign(body, old), timestamp: String(old) },
      { signingSecret: SECRET, now: NOW },
    );
    expect(r.failure).toBe('stale-timestamp');
  });

  it('rejects a timestamp from the future as well as one from the past', () => {
    // Only checking one direction lets a forward-skewed clock widen the replay
    // window indefinitely.
    const ahead = ts + MAX_REQUEST_AGE_SECONDS + 1;
    const r = verifySlackRequest(
      body,
      { signature: sign(body, ahead), timestamp: String(ahead) },
      { signingSecret: SECRET, now: NOW },
    );
    expect(r.failure).toBe('stale-timestamp');
  });

  it('rejects a request with no signature headers at all', () => {
    expect(
      verifySlackRequest(body, { signature: null, timestamp: null }, { signingSecret: SECRET })
        .failure,
    ).toBe('missing-headers');
    expect(
      verifySlackRequest(
        body,
        { signature: sign(body, ts), timestamp: 'not-a-number' },
        { signingSecret: SECRET, now: NOW },
      ).failure,
    ).toBe('missing-headers');
  });
});

describe('who is allowed to ask', () => {
  // The gate that matters. A verified signature proves Slack sent the request.
  // It says nothing about whether that person may see AHN's money.
  it('requires seeing company money for every command', () => {
    for (const capability of Object.values(COMMAND_CAPABILITY)) {
      expect(capability).toBe('see_all_money');
    }
  });

  it('answers the roles trusted with the whole picture', () => {
    for (const role of ['owner', 'cfo', 'accountant', 'viewer'] as UserRole[]) {
      expect(can(role, 'see_all_money'), role).toBe(true);
    }
  });

  it('refuses the scoped roles, who see less than a viewer by design', () => {
    for (const role of ['department_lead', 'project_manager', 'employee'] as UserRole[]) {
      expect(can(role, 'see_all_money'), role).toBe(false);
    }
  });

  it('tells an unlinked Slack account what to do rather than just refusing', () => {
    const text = unlinkedReply('U0999').text;
    expect(text).toContain('U0999');
    expect(text).toContain('not linked');
    // The point that must land: being in the workspace is not permission.
    expect(text).toContain('workspace');
  });

  it('names the role when refusing, so the reason is not a mystery', () => {
    expect(forbiddenReply('employee').text).toContain('employee');
  });
});

describe('parseCommand', () => {
  it('understands the commands and their obvious synonyms', () => {
    expect(parseCommand('cash').name).toBe('cash');
    expect(parseCommand('  BALANCE ').name).toBe('cash');
    expect(parseCommand('spending').name).toBe('spend');
    expect(parseCommand('break-even').name).toBe('breakeven');
    expect(parseCommand('anomalies').name).toBe('unusual');
  });

  it('offers help for an empty command rather than guessing', () => {
    expect(parseCommand('').name).toBe('help');
    expect(parseCommand('   ').unknownWord).toBeUndefined();
  });

  it('names the word it did not understand instead of picking something close', () => {
    // A finance bot that answers approximately is worse than one that says it
    // did not understand.
    const parsed = parseCommand('profitability');
    expect(parsed.name).toBe('help');
    expect(parsed.unknownWord).toBe('profitability');
    expect(helpText(parsed.unknownWord).text).toContain('profitability');
  });

  it('snaps a window to one the pages actually offer', () => {
    expect(parseCommand('spend').days).toBe(DEFAULT_SPEND_DAYS);
    expect(parseCommand('spend 7').days).toBe(7);
    expect(parseCommand('spend 45').days).toBe(90);
    expect(parseCommand('spend 4000').days).toBe(90);
    expect(parseCommand('spend -5').days).toBe(DEFAULT_SPEND_DAYS);
  });
});

// ─── Formatting ─────────────────────────────────────────────────────────────

const snapshot = (over: Partial<FinancialSnapshot> = {}): FinancialSnapshot =>
  ({
    asOf: '2026-09-02',
    cash: {
      totalUsdMinor: 7_786_057,
      byAccount: [],
      byCompany: [],
      byCurrency: [{ currency: 'USD', totalMinor: 7_786_057, totalUsdMinor: 7_786_057 }],
      heldForReviewUsdMinor: 0,
      unreconciledAccounts: 0,
    },
    monthToDate: {} as never,
    previousMonth: {} as never,
    burn: {
      monthlyBurnUsdMinor: 1_059_763,
      netMonthlyBurnUsdMinor: 338_816,
      monthsSampled: 3,
      worstMonthOutflowUsdMinor: 1_387_396,
      worstMonth: '2026-07-01',
      window: { from: '2026-06-01', to: '2026-08-31' },
      perMonth: [],
      hasEnoughData: true,
    },
    runway: {
      grossMonths: 7.3,
      netMonths: 23,
      worstCaseMonths: 5.6,
      cashPositive: false,
      basis: 'net',
    } as never,
    breakEven: {
      month: { from: '2026-09-01', to: '2026-09-30' },
      requiredRevenueUsdMinor: 1_000_000,
      expenseToDateUsdMinor: 100_000,
      projectedRemainingExpenseUsdMinor: 900_000,
      revenueReceivedUsdMinor: 400_000,
      gapUsdMinor: 600_000,
      surplusUsdMinor: 0,
      daysElapsed: 2,
      daysRemaining: 28,
    },
    netProfitMtdUsdMinor: 0,
    revenueMoMChange: null,
    ...over,
  }) as FinancialSnapshot;

describe('formatting', () => {
  const url = 'https://app.example.com';

  it('reports cash with a link back to the accounts it came from', () => {
    const text = formatCash(snapshot(), url).text;
    expect(text).toContain('$77,860.57');
    expect(text).toContain(`${url}/accounts`);
  });

  it('says money is held out of the total when it is', () => {
    const text = formatCash(
      snapshot({
        cash: { ...snapshot().cash, heldForReviewUsdMinor: 50_000, unreconciledAccounts: 2 },
      }),
      url,
    ).text;
    expect(text).toContain('$500.00');
    // Stated as incomplete history, not as a warning that the total is wrong:
    // the total already uses the provider's own reported balance.
    expect(text).toContain('2 account(s)');
    expect(text).toContain('does not yet fully explain');
    expect(text).not.toContain(':warning:');
  });

  it('refuses to state a runway before a complete month exists', () => {
    // "Infinite runway" from no data is a reassurance built on nothing.
    const text = formatRunway(
      snapshot({ burn: { ...snapshot().burn, hasEnoughData: false } }),
      url,
    ).text;
    expect(text).toContain('cannot be calculated honestly');
    expect(text).not.toContain('months*');
  });

  it('says cash positive rather than dividing by a net burn of zero', () => {
    const text = formatRunway(
      snapshot({ runway: { ...snapshot().runway, cashPositive: true, netMonths: null } }),
      url,
    ).text;
    expect(text).toContain('cash positive');
  });

  it('names the worst month rather than only the average', () => {
    expect(formatBurn(snapshot(), url).text).toContain('Jul 2026');
    expect(formatRunway(snapshot(), url).text).toContain('5.6 months');
  });

  it('states the gap to break-even, and the surplus once it is passed', () => {
    expect(formatBreakEven(snapshot(), url).text).toContain('$6,000.00');
    const passed = formatBreakEven(
      snapshot({
        breakEven: { ...snapshot().breakEven, gapUsdMinor: 0, surplusUsdMinor: 250_000 },
      }),
      url,
    ).text;
    expect(passed).toContain('Break-even passed');
    expect(passed).toContain('$2,500.00');
  });

  const change = (over: Partial<CashChange> = {}): CashChange =>
    ({
      from: '2026-08-03',
      to: '2026-09-02',
      openingUsdMinor: 7_316_709,
      closingUsdMinor: 7_786_057,
      netChangeUsdMinor: 469_348,
      inflowUsdMinor: 1_417_422,
      outflowUsdMinor: 948_074,
      inflowDrivers: [],
      outflowDrivers: [
        { label: 'people', amountUsdMinor: 500_000, share: 0.53, count: 4 },
        { label: 'software', amountUsdMinor: 448_074, share: 0.47, count: 12 },
      ],
      largest: [],
      reconciles: true,
      ...over,
    }) as CashChange;

  it('breaks spending down and links to the full picture', () => {
    const text = formatSpend(change(), 30, url).text;
    expect(text).toContain('$9,480.74');
    expect(text).toContain('53%');
    expect(text).toContain(`${url}/explain?days=30`);
  });

  it('never lets a breakdown that does not reconcile pass silently into Slack', () => {
    expect(formatSpend(change({ reconciles: false }), 30, url).text).toContain(
      'does not reconcile',
    );
  });

  const anomaly = (over: Partial<Anomaly> = {}): Anomaly =>
    ({
      transaction: { txn_date: '2026-08-28' } as Transaction,
      label: 'Stripe',
      amountUsdMinor: 24_680,
      typicalUsdMinor: 391,
      multiple: 63.1,
      sampleSize: 12,
      alsoUnusualCount: 2,
      reason: 'charges vary with something',
      ...over,
    }) as Anomaly;

  it('reports an unusual charge with what is unusual about it', () => {
    const text = formatUnusual([anomaly()], url).text;
    expect(text).toContain('Stripe');
    expect(text).toContain('63.1×');
    expect(text).toContain('+2 more');
  });

  it('explains the quiet case instead of just saying none', () => {
    // Otherwise silence reads as "the detector is broken".
    const text = formatUnusual([], url).text;
    expect(text).toContain('Nothing recent is unusual');
    expect(text).toContain('own history');
  });
});

describe('every reply', () => {
  const url = 'https://app.example.com';
  const replies = [
    helpText(),
    helpText('nonsense'),
    formatCash(snapshot(), url),
    formatRunway(snapshot(), url),
    formatBurn(snapshot(), url),
    formatBreakEven(snapshot(), url),
    formatSpend({ outflowUsdMinor: 0 } as CashChange, 30, url),
    formatUnusual([], url),
    unlinkedReply('U1'),
    forbiddenReply('employee'),
  ];

  it('is ephemeral, always', () => {
    // The permission check is per person. Posting the answer into the channel
    // would hand it to everyone in the room regardless of their role, which
    // would make that check decorative.
    for (const r of replies) expect(r.response_type).toBe('ephemeral');
  });
});
