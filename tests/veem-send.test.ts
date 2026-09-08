import { describe, expect, it } from 'vitest';
import { buildPaymentPayload, sendPayment, splitName } from '@/lib/connectors/veem';

const input = {
  requestId: '11111111-2222-4333-8444-555555555555',
  payeeEmail: 'jomar@example.com',
  payeeFirstName: 'Jomar',
  payeeLastName: 'Reyes',
  payeeCountryCode: 'ph',
  amountMajor: 1450,
  currency: 'usd',
  purposeOfPayment: 'Payroll August 2026',
};

describe('sendPayment', () => {
  it('sends nothing unless asked to, explicitly', async () => {
    // The default is a dry run. There is no Veem sandbox — the first real send
    // is against production money — so the safe default is "do not".
    const out = await sendPayment(input);
    expect(out.sent).toBe(false);
    expect(out.error).toBeNull();
    expect(out.payload).toBeTruthy();
  });

  it('is still a dry run when dryRun is left undefined', async () => {
    const out = await sendPayment(input, { accessToken: 'x' });
    expect(out.sent).toBe(false);
  });
});

describe('buildPaymentPayload', () => {
  it('uppercases the currency and country Veem expects', () => {
    const p = buildPaymentPayload(input) as {
      amount: { currency: string; number: number };
      payee: { countryCode: string };
    };
    expect(p.amount.currency).toBe('USD');
    expect(p.payee.countryCode).toBe('PH');
  });

  it('sends a major-unit amount, converted once at the boundary', () => {
    // The ledger is in minor units everywhere. The single conversion happens
    // here rather than being scattered, so there is one place to be wrong.
    const p = buildPaymentPayload({ ...input, amountMajor: 1450 }) as { amount: { number: number } };
    expect(p.amount.number).toBe(1450);
  });

  it('omits the funding method when none is configured', () => {
    // Sending `fundingMethod: { id: null }` would be a claim about an account
    // that does not exist.
    expect(buildPaymentPayload(input).fundingMethod).toBeUndefined();
    expect(
      buildPaymentPayload({ ...input, fundingMethodId: 'fm_1' }).fundingMethod,
    ).toEqual({ id: 'fm_1', type: 'Bank' });
  });

  it('carries the purpose through', () => {
    expect(buildPaymentPayload(input).purposeOfPayment).toBe('Payroll August 2026');
  });
});

describe('splitName', () => {
  it('splits on the last space', () => {
    expect(splitName('Jomar Reyes')).toEqual({ firstName: 'Jomar', lastName: 'Reyes' });
    expect(splitName('Maria Clara Santos')).toEqual({ firstName: 'Maria Clara', lastName: 'Santos' });
  });

  it('repeats a single name rather than inventing a surname', () => {
    // Veem requires both fields. Repeating what we know is honest; making up
    // a surname to fill a required field is not.
    expect(splitName('Prince')).toEqual({ firstName: 'Prince', lastName: 'Prince' });
  });
});
