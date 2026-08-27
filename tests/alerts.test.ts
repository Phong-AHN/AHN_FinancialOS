import { describe, expect, it } from 'vitest';
import { selectAlertPlan } from '@/lib/alerts/engine';
import { formatTransactionAlert } from '@/lib/alerts/format';
import type { AlertRule, TransactionWithContext } from '@/lib/types';

function rule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'rule-1',
    name: 'Money out - any amount',
    type: 'money_out',
    severity: 'info',
    channels: ['slack', 'email'],
    threshold_minor: null,
    threshold_number: null,
    enabled: true,
    config: {},
    created_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

describe('selectAlertPlan', () => {
  it('fires on every outflow by default, with no minimum', () => {
    // Spec section 4: "Default alert mode: every dollar."
    const plan = selectAlertPlan({ direction: 'outflow' }, 1, [rule()]);
    expect(plan).not.toBeNull();
    expect(plan!.channels).toContain('slack');
  });

  it('does not fire an outflow rule on an inflow', () => {
    expect(selectAlertPlan({ direction: 'inflow' }, 500_000, [rule()])).toBeNull();
  });

  it('merges overlapping rules into ONE alert', () => {
    // A large payroll run matches both "money out" and "unusually large
    // outflow". Firing both would send the CEO the same payment twice.
    const plan = selectAlertPlan({ direction: 'outflow' }, 800_000, [
      rule(),
      rule({
        id: 'rule-2',
        name: 'Unusually large outflow',
        type: 'large_outflow',
        severity: 'warning',
        channels: ['slack', 'email', 'sms'],
        threshold_minor: 500_000,
      }),
    ]);

    expect(plan!.ruleIds).toHaveLength(2);
    expect(plan!.severity).toBe('warning');
    expect([...plan!.channels].sort()).toEqual(['email', 'in_app', 'slack', 'sms']);
  });

  it('leaves a below-threshold outflow at info severity', () => {
    const plan = selectAlertPlan({ direction: 'outflow' }, 100_000, [
      rule(),
      rule({ id: 'rule-2', type: 'large_outflow', severity: 'warning', channels: ['sms'], threshold_minor: 500_000 }),
    ]);
    expect(plan!.severity).toBe('info');
    expect(plan!.channels).not.toContain('sms');
  });

  it('ignores disabled rules', () => {
    expect(selectAlertPlan({ direction: 'outflow' }, 100_000, [rule({ enabled: false })])).toBeNull();
  });

  it('respects a per-rule minimum amount', () => {
    const quiet = rule({ threshold_minor: 100_000 });
    expect(selectAlertPlan({ direction: 'outflow' }, 99_999, [quiet])).toBeNull();
    expect(selectAlertPlan({ direction: 'outflow' }, 100_000, [quiet])).not.toBeNull();
  });

  it('always includes the in-app channel, which is also the delivery log', () => {
    const plan = selectAlertPlan({ direction: 'outflow' }, 1, [rule({ channels: ['slack'] })]);
    expect(plan!.channels).toContain('in_app');
  });

  it('never routes state-based rules through the transaction path', () => {
    expect(
      selectAlertPlan({ direction: 'outflow' }, 999_999, [
        rule({ type: 'low_runway', threshold_number: 6 }),
        rule({ id: 'r3', type: 'daily_summary', severity: 'digest' }),
      ]),
    ).toBeNull();
  });
});

describe('formatTransactionAlert', () => {
  const txn = {
    id: 'txn-1',
    amount_minor: 1_250_000,
    currency: 'USD',
    direction: 'inflow',
    txn_date: '2026-08-26',
    category: 'revenue',
    source_system: 'quickbooks',
    account: { id: 'a', name: 'US Operating', currency: 'USD', type: 'checking' },
    counterparty: { id: 'c', name: 'Client X', type: 'customer' },
  } as unknown as TransactionWithContext;

  it('matches the shape of the example in spec section 4', () => {
    const alert = formatTransactionAlert(txn, {
      totalCashUsdMinor: 28_430_000,
      runwayMonths: 7.8,
      appUrl: 'https://fin.ahn.test',
    });

    expect(alert.text).toContain('$12,500.00');
    expect(alert.text).toContain('Client X');
    expect(alert.text).toContain('US Operating');
    expect(alert.text).toContain('$284,300.00');
    expect(alert.text).toContain('7.8 months');
  });

  it('deep-links back to the transaction', () => {
    const alert = formatTransactionAlert(txn, {
      totalCashUsdMinor: 0,
      runwayMonths: null,
      appUrl: 'https://fin.ahn.test',
    });
    expect(alert.url).toBe('https://fin.ahn.test/transactions/txn-1');
  });

  it('keeps SMS inside one segment', () => {
    const alert = formatTransactionAlert(
      { ...txn, counterparty: { id: 'c', name: 'A'.repeat(200), type: 'customer' } } as TransactionWithContext,
      { totalCashUsdMinor: 28_430_000, runwayMonths: 7.8, appUrl: 'https://fin.ahn.test' },
    );
    expect(alert.sms.length).toBeLessThanOrEqual(160);
  });

  it('signs an outflow as negative', () => {
    const alert = formatTransactionAlert(
      { ...txn, direction: 'outflow', amount_minor: 480_000 } as TransactionWithContext,
      { totalCashUsdMinor: 100_000, runwayMonths: null, appUrl: 'https://x.test' },
    );
    expect(alert.text.startsWith('−$4,800.00')).toBe(true);
  });
});
