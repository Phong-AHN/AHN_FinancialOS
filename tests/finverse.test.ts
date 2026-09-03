import { describe, expect, it } from 'vitest';
import {
  amountToMinor,
  mapFinverseAccountType,
  normalizeTransactions,
  toDirection,
  type FinverseTransaction,
} from '@/lib/connectors/finverse';

const accountMap = new Map([['fv-acc-1', 'our-acc-1']]);
const currencyMap = new Map([['fv-acc-1', 'VND']]);

function txn(over: Partial<FinverseTransaction> = {}): FinverseTransaction {
  return {
    transaction_id: 'fv-txn-1',
    account_id: 'fv-acc-1',
    amount: { currency: 'VND', value: -412_500_000, raw: '-412500000' },
    description: 'CHUYEN LUONG NHAN VIEN THANG 06/2026',
    posted_date: '2026-07-05',
    is_pending: false,
    ...over,
  };
}

describe('amountToMinor', () => {
  it('prefers the exact string over the JSON number', () => {
    // `raw` is the figure as a string; `value` has already been through a
    // float. For a VND balance in the hundreds of millions that difference is
    // real money, and the whole ledger rests on never letting a float hold one.
    expect(amountToMinor({ currency: 'HKD', value: 15000, raw: '15000.00' }, 'HKD')).toBe(
      1_500_000,
    );
  });

  it('scales by the currency, not by a fixed 100', () => {
    // VND has no minor unit. 412,500,000 dong is 412500000, not 41250000000.
    expect(amountToMinor({ currency: 'VND', value: -412_500_000, raw: '-412500000' }, 'VND')).toBe(
      -412_500_000,
    );
    expect(amountToMinor({ currency: 'USD', value: -1833.22, raw: '-1833.22' }, 'USD')).toBe(
      -183_322,
    );
  });

  it('handles the extra decimal place the API can return', () => {
    // The SDK fixtures contain 15001.116 — three decimals on a two-decimal
    // currency. Rounding is right; truncating or throwing is not.
    expect(amountToMinor({ currency: 'USD', value: 15001.116, raw: '15001.116' }, 'USD')).toBe(
      1_500_112,
    );
  });

  it('falls back to value when raw is absent', () => {
    expect(amountToMinor({ currency: 'USD', value: -233 }, 'USD')).toBe(-23_300);
  });

  it('returns null rather than zero when there is no amount at all', () => {
    // A row we failed to read is not a zero-value transaction, and booking it
    // as one would put a silent nothing in the ledger.
    expect(amountToMinor(undefined, 'USD')).toBeNull();
    expect(amountToMinor({ currency: 'USD', value: Number.NaN }, 'USD')).toBeNull();
  });
});

describe('toDirection', () => {
  it('reads the sign the way Finverse writes it', () => {
    expect(toDirection(-23_300)).toBe('outflow');
    expect(toDirection(1_500_000)).toBe('inflow');
    expect(toDirection(0)).toBe('inflow');
  });
});

describe('mapFinverseAccountType', () => {
  it('counts current, savings and deposits as cash', () => {
    for (const subtype of ['CURRENT', 'DEBIT_CARD', 'SAVINGS', 'TIME_DEPOSIT']) {
      expect(mapFinverseAccountType(subtype).countsAsCash, subtype).toBe(true);
    }
  });

  it('never counts money owed as money held', () => {
    // The mistake this rule exists for happened once already, on Plaid: a
    // mortgage, a student loan, an auto loan and a HELOC all landed in the
    // headline cash figure because their balances are reported POSITIVE.
    for (const subtype of ['CREDIT_CARD', 'MORTGAGE', 'PERSONAL_LOAN', 'REVOLVING_LOAN']) {
      expect(mapFinverseAccountType(subtype).countsAsCash, subtype).toBe(false);
    }
  });

  it('never counts investments as cash', () => {
    for (const subtype of ['SECURITIES', 'FUNDS', 'STOCKS', 'BONDS']) {
      expect(mapFinverseAccountType(subtype).countsAsCash, subtype).toBe(false);
    }
  });

  it('treats anything it does not recognise as NOT cash', () => {
    // Overstating what a company can spend is the dangerous direction. A
    // balance wrongly left out is visible on the Accounts page; a debt wrongly
    // added to cash is visible nowhere.
    for (const subtype of ['UNKNOWN', 'OTHER', 'SOMETHING_NEW', null, undefined]) {
      expect(mapFinverseAccountType(subtype).countsAsCash, String(subtype)).toBe(false);
    }
  });
});

describe('normalizeTransactions', () => {
  it('maps a Vietnamese outflow into the ledger shape', () => {
    const { rows } = normalizeTransactions([txn()], { accountMap, currencyMap });

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.account_id).toBe('our-acc-1');
    expect(row.direction).toBe('outflow');
    // Positive in the column, with the sign carried by `direction` — the
    // database checks `amount_minor >= 0`, and one figure negative in one place
    // and positive in another is how totals stop adding up.
    expect(row.amount_minor).toBe(412_500_000);
    expect(row.currency).toBe('VND');
    expect(row.txn_date).toBe('2026-07-05');
    expect(row.source_system).toBe('finverse');
    expect(row.external_txn_id).toBe('fv-txn-1');
  });

  it('skips pending rows and says how many', () => {
    // A pending transaction can change amount, change date or vanish. Booking
    // one leaves the ledger disagreeing with the bank a day later, and the
    // reconcile page then reports a variance nobody can explain.
    const result = normalizeTransactions([txn({ is_pending: true }), txn()], {
      accountMap,
      currencyMap,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.skippedPending).toBe(1);
  });

  it('takes pending rows when explicitly asked', () => {
    const result = normalizeTransactions([txn({ is_pending: true })], {
      accountMap,
      currencyMap,
      includePending: true,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.skippedPending).toBe(0);
  });

  it('refuses to place a transaction from an account it does not know', () => {
    const result = normalizeTransactions([txn({ account_id: 'fv-acc-unknown' })], {
      accountMap,
      currencyMap,
    });
    expect(result.rows).toHaveLength(0);
    expect(result.skippedUnknownAccount).toBe(1);
  });

  it('drops a row it could not read the amount of, rather than booking zero', () => {
    const result = normalizeTransactions([txn({ amount: undefined })], {
      accountMap,
      currencyMap,
    });
    expect(result.rows).toHaveLength(0);
    expect(result.skippedNoAmount).toBe(1);
  });

  it('trusts the amount currency over the account currency', () => {
    // A VND account can hold a USD-denominated line. Assuming the account's
    // currency would convert it at 26,000× the truth.
    const result = normalizeTransactions(
      [txn({ amount: { currency: 'USD', value: -100, raw: '-100.00' } })],
      { accountMap, currencyMap },
    );
    expect(result.rows[0]!.currency).toBe('USD');
    expect(result.rows[0]!.amount_minor).toBe(10_000);
  });

  it('falls back to the transaction time when there is no posted date', () => {
    const result = normalizeTransactions(
      [txn({ posted_date: undefined, transaction_time: '2026-07-05T09:14:00Z' })],
      { accountMap, currencyMap },
    );
    expect(result.rows[0]!.txn_date).toBe('2026-07-05');
  });

  it('carries the merchant through as the counterparty', () => {
    const result = normalizeTransactions([txn({ merchant_name: 'Grab Vietnam' })], {
      accountMap,
      currencyMap,
    });
    expect(result.rows[0]!.counterparty_name).toBe('Grab Vietnam');
  });
});
