import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { plaidConfigProblems, plaidEnvironment } from '@/lib/connectors/plaid';
import { stripeConfigProblems, stripeMode } from '@/lib/connectors/stripe';

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('plaidEnvironment', () => {
  beforeEach(() => {
    process.env.PLAID_CLIENT_ID = 'id';
    process.env.PLAID_SECRET = 'secret';
  });

  it('accepts the two environments Plaid still runs', () => {
    process.env.PLAID_ENV = 'sandbox';
    expect(plaidEnvironment()).toMatchObject({ environment: 'sandbox', valid: true, isSimulated: true });

    process.env.PLAID_ENV = 'production';
    expect(plaidEnvironment()).toMatchObject({ environment: 'production', valid: true, isSimulated: false });
  });

  it('rejects the retired "development" environment with a usable explanation', () => {
    // development.plaid.com no longer resolves. Left unchecked, the only symptom
    // is a DNS error that says nothing about the actual cause.
    process.env.PLAID_ENV = 'development';
    expect(plaidEnvironment().valid).toBe(false);

    const explanation = plaidConfigProblems().join(' ');
    expect(explanation).toContain('retired');
    expect(explanation).toContain('sandbox');
    expect(explanation).toContain('production');
  });

  it('falls back to sandbox, never production, when the value is unusable', () => {
    // An unclear configuration must not be the reason a live banking call goes out.
    process.env.PLAID_ENV = 'nonsense';
    expect(plaidEnvironment().environment).toBe('sandbox');
  });

  it('names each missing credential separately', () => {
    delete process.env.PLAID_SECRET;
    process.env.PLAID_ENV = 'sandbox';
    const problems = plaidConfigProblems();
    expect(problems.some((p) => p.includes('PLAID_SECRET'))).toBe(true);
    expect(problems.some((p) => p.includes('PLAID_CLIENT_ID'))).toBe(false);
  });
});

describe('stripeMode', () => {
  it('tells a live key from a test key', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc123';
    expect(stripeMode()).toBe('live');

    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
    expect(stripeMode()).toBe('test');

    process.env.STRIPE_SECRET_KEY = 'rk_live_abc123';
    expect(stripeMode()).toBe('restricted');
  });

  it('flags a value that is not a Stripe secret key at all', () => {
    process.env.STRIPE_SECRET_KEY = 'pk_live_abc123';
    expect(stripeMode()).toBe('unknown');
    expect(stripeConfigProblems().join(' ')).toContain('does not look like');
  });

  it('reports the key as missing rather than guessing a mode', () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(stripeMode()).toBeNull();
    expect(stripeConfigProblems().join(' ')).toContain('STRIPE_SECRET_KEY');
  });
});
