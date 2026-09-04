import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertable, describeSandboxed, sandboxSources } from '@/lib/alerts/sandbox';

/**
 * Nothing from a test environment wakes anybody up.
 *
 * QuickBooks' sandbox company ships with 31 invoices, most long overdue and
 * none ever going to be paid. Importing them was right; paging AHN about them
 * was not — twelve Slack messages went out before this existed, with more
 * arriving daily as the fake receivables aged.
 */
describe('sandboxSources', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('treats a QuickBooks sandbox as not-real money', () => {
    vi.stubEnv('QBO_ENVIRONMENT', 'sandbox');
    expect(sandboxSources().has('quickbooks')).toBe(true);
  });

  it('lets production QuickBooks through', () => {
    // The suppression has to disappear on its own the day AHN switches, or
    // somebody will forget it exists and wonder why alerts stopped.
    vi.stubEnv('QBO_ENVIRONMENT', 'production');
    expect(sandboxSources().has('quickbooks')).toBe(false);
  });

  it('reads Stripe from the key, because Stripe has no environment setting', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_abc123');
    expect(sandboxSources().has('stripe')).toBe(true);
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_abc123');
    expect(sandboxSources().has('stripe')).toBe(false);
  });

  it('treats an unset Plaid environment as sandbox, never production', () => {
    // An unclear config must not be the reason a live alert goes out.
    vi.stubEnv('PLAID_ENV', '');
    expect(sandboxSources().has('plaid')).toBe(true);
  });
});

describe('alertable', () => {
  const sandboxed = new Set(['quickbooks'] as const);

  it('suppresses a row from a sandboxed source', () => {
    expect(alertable({ source_system: 'quickbooks' }, sandboxed as never)).toBe(false);
  });

  it('lets a live source through', () => {
    expect(alertable({ source_system: 'vietinbank' }, sandboxed as never)).toBe(true);
  });

  it('treats hand-entered money as real', () => {
    // Somebody typed it deliberately. Silence is the wrong default for that.
    expect(alertable({ source_system: 'manual' }, sandboxed as never)).toBe(true);
    expect(alertable({ source_system: null }, sandboxed as never)).toBe(true);
    expect(alertable({}, sandboxed as never)).toBe(true);
  });
});

describe('describeSandboxed', () => {
  it('says nothing when everything is live', () => {
    expect(describeSandboxed(new Set())).toBeNull();
  });

  it('names the sources so a summary can explain the silence', () => {
    // "0 sent" and "0 sent, 25 suppressed because QuickBooks is in sandbox"
    // are different situations, and only one means alerting is broken.
    expect(describeSandboxed(new Set(['quickbooks', 'plaid'] as never))).toBe('plaid, quickbooks');
  });
});
