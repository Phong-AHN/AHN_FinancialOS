import { describe, expect, it } from 'vitest';
import {
  MAX_PAYMENT_USD_MINOR,
  MAX_RUN_USD_MINOR,
  describeRun,
  refusalsFor,
  runTotal,
  sendRefusal,
  type PayableLine,
} from '@/lib/payroll/guards';

const line = (over: Partial<PayableLine> = {}): PayableLine => ({
  personId: 'p1',
  payeeName: 'Jomar Reyes',
  payeeEmail: 'jomar@example.com',
  payeeCountry: 'PH',
  amountMinor: 145_000,
  currency: 'USD',
  ...over,
});

describe('refusalsFor', () => {
  it('passes a clean run', () => {
    expect(refusalsFor([line(), line({ payeeEmail: 'maria@example.com' })])).toEqual([]);
  });

  it('refuses an empty run', () => {
    expect(refusalsFor([])[0]!.reason).toMatch(/nobody to pay/);
  });

  it('catches an amount above the single-payment ceiling', () => {
    // The failure this guard exists for is a UNITS error: toMinor applied twice
    // turns $4,800 into $480,000, and every other check still passes.
    const out = refusalsFor([line({ amountMinor: 48_000_000 })]);
    expect(out.some((r) => /ceiling/.test(r.reason))).toBe(true);
  });

  it('catches a non-integer or negative amount', () => {
    expect(refusalsFor([line({ amountMinor: 1450.5 })])[0]!.reason).toMatch(/whole number/);
    expect(refusalsFor([line({ amountMinor: -100 })])[0]!.reason).toMatch(/positive/);
    expect(refusalsFor([line({ amountMinor: 0 })])[0]!.reason).toMatch(/positive/);
  });

  it('catches the same person twice in one run', () => {
    // A duplicate, not a bonus.
    const out = refusalsFor([line(), line({ personId: 'p2' })]);
    expect(out.some((r) => /twice|2 times/.test(r.reason))).toBe(true);
  });

  it('is case-insensitive about the duplicate check', () => {
    const out = refusalsFor([line(), line({ personId: 'p2', payeeEmail: 'JOMAR@EXAMPLE.COM' })]);
    expect(out.some((r) => /2 times/.test(r.reason))).toBe(true);
  });

  it('refuses an unpayable email or country', () => {
    expect(refusalsFor([line({ payeeEmail: 'not-an-email' })])[0]!.reason).toMatch(/email/);
    expect(refusalsFor([line({ payeeCountry: 'PHL' })])[0]!.reason).toMatch(/country code/);
  });

  it('refuses a run that mixes currencies', () => {
    // Adding dong to dollars produces a total nobody can approve.
    const out = refusalsFor([line(), line({ payeeEmail: 'b@x.com', currency: 'VND' })]);
    expect(out.some((r) => /One run, one currency/.test(r.reason))).toBe(true);
  });

  it('refuses a run above the whole-run ceiling', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      line({ payeeEmail: `p${i}@x.com`, amountMinor: MAX_PAYMENT_USD_MINOR }),
    );
    expect(runTotal(many)).toBeGreaterThan(MAX_RUN_USD_MINOR);
    expect(refusalsFor(many).some((r) => r.line === 'the whole run')).toBe(true);
  });

  it('reports every problem at once, not the first', () => {
    // Somebody fixing a run should see the whole list rather than discover a
    // new fault on each attempt.
    const out = refusalsFor([line({ payeeEmail: 'bad', payeeCountry: 'XYZ', payeeName: '  ' })]);
    expect(out.length).toBeGreaterThanOrEqual(3);
  });
});

describe('sendRefusal', () => {
  const approved = {
    status: 'approved',
    created_by: 'alice',
    approved_by: 'bob',
    approved_total_minor: 100_000,
  };

  it('lets an approved run through when the total still matches', () => {
    expect(sendRefusal(approved, 100_000)).toBeNull();
  });

  it('refuses a draft', () => {
    expect(sendRefusal({ ...approved, status: 'draft' }, 100_000)).toMatch(/not been approved/);
  });

  it('refuses a run already sent or in flight', () => {
    expect(sendRefusal({ ...approved, status: 'sent' }, 100_000)).toMatch(/already been sent/);
    expect(sendRefusal({ ...approved, status: 'sending' }, 100_000)).toMatch(/already being sent/);
  });

  it('refuses self-approval', () => {
    // An approval somebody can give themselves is a formality, not a control.
    expect(sendRefusal({ ...approved, approved_by: 'alice' }, 100_000)).toMatch(/same person/);
  });

  it('refuses when the total changed after approval', () => {
    // The whole reason approval exists: $40,000 signed off must not become
    // $60,000 because a line moved in between.
    expect(sendRefusal(approved, 6_000_000)).toMatch(/approved at .* but now totals/);
  });
});

describe('describeRun', () => {
  it('reads as a sentence somebody can check before clicking', () => {
    expect(describeRun([line(), line({ payeeEmail: 'b@x.com' })], { start: '2026-08-01', end: '2026-08-31' }))
      .toBe('2 people, 2900.00 USD, for 2026-08-01 to 2026-08-31');
  });

  it('says "person" for one', () => {
    expect(describeRun([line()], { start: '2026-08-01', end: '2026-08-31' })).toMatch(/^1 person,/);
  });
});
