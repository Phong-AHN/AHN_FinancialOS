import { describe, expect, it } from 'vitest';
import {
  VEEM_PRODUCTION_BASE,
  amountToMinor,
  counterpartyName,
  normalizePayment,
  splitByStatus,
  toReportDate,
  veemBase,
  veemConfigProblems,
  type VeemPayment,
} from '@/lib/connectors/veem';

/** Shaped from the documented payment-report response. */
const payment = (over: Partial<VeemPayment> = {}): VeemPayment => ({
  id: 8841203,
  status: 'Complete',
  timeCreated: '2026-07-08T09:14:22.000Z',
  payee: {
    countryCode: 'PH',
    firstName: 'Jomar',
    lastName: 'Reyes',
    payeeAmount: { number: 82_000, currency: 'PHP' },
  },
  payer: {
    countryCode: 'US',
    payerAccountId: 55501,
    fundingMethodType: 'Bank',
    payerAmount: { number: 1450, currency: 'USD' },
  },
  ...over,
});

describe('configuration', () => {
  it('defaults to the host that actually answers', () => {
    // sandbox-api.veem.com returns a 403 HTML sign-in page on every path,
    // including /oauth/token. There is no sandbox to fall back to.
    expect(veemBase()).toBe(VEEM_PRODUCTION_BASE);
  });

  it('names each missing credential separately', () => {
    const problems = veemConfigProblems();
    // Both are absent in test, and the point is that `/integrations` can say
    // which one rather than "not configured".
    expect(problems.join(' ')).toContain('VEEM_CLIENT_ID');
    expect(problems.join(' ')).toContain('VEEM_CLIENT_SECRET');
  });
});

describe('amountToMinor', () => {
  it('scales by the currency, not by a hardcoded 100', () => {
    expect(amountToMinor({ number: 1450, currency: 'USD' })).toEqual({
      minor: 145_000,
      currency: 'USD',
    });
  });

  it('reads a string amount without going through a float', () => {
    expect(amountToMinor({ number: '1450.55', currency: 'USD' })!.minor).toBe(145_055);
  });

  it('returns null rather than zero for a missing amount', () => {
    // Zero is a number somebody could act on. Null is not.
    expect(amountToMinor(undefined)).toBeNull();
    expect(amountToMinor({ currency: 'USD' })).toBeNull();
  });
});

describe('normalizePayment', () => {
  it('takes the amount that left AHN, not the amount the payee received', () => {
    // A Philippines payee receiving ₱82,000 is not what came out of AHN's USD
    // balance. Recording the payee side would put pesos in a dollar ledger.
    const n = normalizePayment(payment())!;
    expect(n.amountMinor).toBe(145_000);
    expect(n.currency).toBe('USD');
    expect(n.direction).toBe('outflow');
  });

  it('treats a payment as outgoing when we cannot tell', () => {
    // Stated assumption, not a disguised guess: AHN's documented use is sending
    // Philippines payroll, and the report is scoped to AHN's own account.
    expect(normalizePayment(payment(), {})!.direction).toBe('outflow');
  });

  it('recognises money coming in once the account id is known', () => {
    const n = normalizePayment(payment(), { ownAccountId: '99999' })!;
    expect(n.direction).toBe('inflow');
    // And then the payee side is the side that reached us.
    expect(n.currency).toBe('PHP');
  });

  it('keeps Veem’s own id so a re-sync updates rather than duplicates', () => {
    expect(normalizePayment(payment())!.externalId).toBe('veem:8841203');
  });

  it('refuses a payment with no id', () => {
    expect(normalizePayment(payment({ id: undefined }))).toBeNull();
  });

  it('refuses a payment with no usable amount', () => {
    expect(
      normalizePayment(payment({ payer: { payerAmount: {} }, payee: { payeeAmount: {} } })),
    ).toBeNull();
  });

  it('reads the date without inventing one', () => {
    expect(normalizePayment(payment())!.date).toBe('2026-07-08');
    expect(normalizePayment(payment({ timeCreated: undefined }))!.date).toBeNull();
  });
});

describe('counterpartyName', () => {
  it('prefers a business name, then a person, then an email', () => {
    expect(counterpartyName(payment({ payee: { businessName: 'Acme Ltd' } }), 'outflow')).toBe(
      'Acme Ltd',
    );
    expect(counterpartyName(payment(), 'outflow')).toBe('Jomar Reyes');
    expect(counterpartyName(payment({ payee: { email: 'a@b.com' } }), 'outflow')).toBe('a@b.com');
  });

  it('makes a missing name visibly missing', () => {
    // "VEEM payment 8841203" reads as an absent name. A blank or a dash would
    // read as a counterparty nobody can look up.
    expect(counterpartyName(payment({ payee: {} }), 'outflow')).toBe('VEEM payment 8841203');
  });
});

describe('splitByStatus', () => {
  const of = (status: string) => normalizePayment(payment({ id: status, status }))!;

  it('counts only a completed payment as cash', () => {
    // The decision this connector turns on. A payment Veem has accepted but not
    // delivered has not left the bank; counting it as cash overstates what went
    // out and understates the balance.
    const split = splitByStatus([of('Complete')]);
    expect(split.settled).toHaveLength(1);
    expect(split.inFlight).toHaveLength(0);
  });

  it('treats a payment in flight as a commitment, not as nothing', () => {
    // Spec §18: a known commitment before money leaves the bank. Same place a
    // QuickBooks bill goes.
    const split = splitByStatus(
      ['Drafted', 'Sent', 'PendingAuth', 'Authorized', 'InProgress'].map(of),
    );
    expect(split.inFlight).toHaveLength(5);
    expect(split.settled).toHaveLength(0);
    expect(split.discarded).toHaveLength(0);
  });

  it('discards what is never going to happen', () => {
    const split = splitByStatus(['Cancelled', 'Closed'].map(of));
    expect(split.discarded).toHaveLength(2);
    expect(split.settled).toHaveLength(0);
    expect(split.inFlight).toHaveLength(0);
  });

  it('puts every payment in exactly one bucket', () => {
    const all = [
      'Drafted', 'Sent', 'PendingAuth', 'Authorized',
      'InProgress', 'Complete', 'Cancelled', 'Closed',
    ].map(of);
    const s = splitByStatus(all);
    expect(s.settled.length + s.inFlight.length + s.discarded.length).toBe(all.length);
  });
});

describe('toReportDate', () => {
  it('sends ISO 8601, which is what startDate wants', () => {
    expect(toReportDate('2026-07-08')).toBe('2026-07-08T00:00:00Z');
  });
});
