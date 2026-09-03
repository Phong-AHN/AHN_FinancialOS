import { describe, expect, it } from 'vitest';
import {
  amountToMinor,
  mapFinverseAccountType,
  normalizeTransactions,
  type FinverseAccount,
  type FinverseTransaction,
} from '@/lib/connectors/finverse';

/**
 * The connector, run against Finverse's OWN example payloads.
 *
 * There are no Finverse credentials yet, so the HTTP calls in the connector
 * have never executed. This is the closest thing to verification available
 * without them: the payloads below are copied verbatim from
 * `finversetech/sdk-typescript`, `test/responses/account.ts` and
 * `test/responses/transaction.ts` — the fixtures the vendor tests its own
 * client against.
 *
 * What this proves: the field names, the nesting and the money representation
 * this connector expects are the ones Finverse actually sends. What it does NOT
 * prove: that the endpoints answer, that the paths are right, or that a real
 * Vietnamese bank returns the same shape as the vendor's HKD examples. Those
 * need a sandbox key, and this file should be re-run against a real response
 * the day one exists.
 */

// ── Verbatim from the SDK's test/responses/account.ts ────────────────────────
const VENDOR_ACCOUNTS = [
  {
    account_currency: 'HKD',
    account_id: '01F7MP3XTNX36K9N66JPKH131P',
    account_name: 'HKD Checking',
    balance: { currency: 'HKD', raw: '70013.12', value: 70013.12 },
    is_closed: false,
    is_excluded: false,
    account_type: { type: 'DEPOSIT', subtype: 'CURRENT' },
  },
  {
    account_currency: 'HKD',
    account_id: '01F7MP3XTQ4Y8AFQ9KDFQXF14Y',
    account_name: 'HKD Credit Card',
    balance: { currency: 'HKD', raw: '-1833.22', value: -1833.22 },
    is_closed: false,
    is_excluded: false,
    account_type: { type: 'CREDIT', subtype: 'CREDIT_CARD' },
  },
] satisfies FinverseAccount[];

// ── Verbatim from the SDK's test/responses/transaction.ts ────────────────────
const VENDOR_TRANSACTIONS = [
  {
    account_id: '01F7MP3XTNX36K9N66JPKH131P',
    amount: { currency: 'HKD', raw: '15000.00', value: 15000 },
    created_at: '2022-01-07T03:49:32.620Z',
    description: 'Salary',
    is_pending: false,
    posted_date: '2020-12-01',
    transaction_id: '01FRSAGN9VNWZXD7FY6A180XC2',
  },
  {
    account_id: '01F7MP3XTQ4Y8AFQ9KDFQXF14Y',
    amount: { currency: 'HKD', raw: '-233.00', value: -233 },
    created_at: '2022-01-07T03:49:32.620Z',
    description: 'NETFLICKS PAYMENT THANKS',
    is_pending: false,
    posted_date: '2020-11-22',
    transaction_id: '01FRSAGNAA2CPE5HFN9A91QMTJ',
  },
] satisfies FinverseTransaction[];

describe("Finverse's own example payloads", () => {
  const accountMap = new Map(VENDOR_ACCOUNTS.map((a, i) => [a.account_id, `our-acc-${i}`]));
  const currencyMap = new Map(VENDOR_ACCOUNTS.map((a) => [a.account_id, a.account_currency!]));

  it('reads the account balances exactly', () => {
    expect(amountToMinor(VENDOR_ACCOUNTS[0]!.balance, 'HKD')).toBe(7_001_312);
    expect(amountToMinor(VENDOR_ACCOUNTS[1]!.balance, 'HKD')).toBe(-183_322);
  });

  it('keeps the credit card out of cash', () => {
    expect(mapFinverseAccountType(VENDOR_ACCOUNTS[0]!.account_type?.subtype).countsAsCash).toBe(
      true,
    );
    expect(mapFinverseAccountType(VENDOR_ACCOUNTS[1]!.account_type?.subtype).countsAsCash).toBe(
      false,
    );
  });

  it('turns both example transactions into ledger rows', () => {
    const { rows, skippedPending, skippedUnknownAccount, skippedNoAmount } = normalizeTransactions(
      VENDOR_TRANSACTIONS,
      { accountMap, currencyMap },
    );

    expect(rows).toHaveLength(2);
    expect(skippedPending + skippedUnknownAccount + skippedNoAmount).toBe(0);

    const salary = rows[0]!;
    expect(salary.direction).toBe('inflow');
    expect(salary.amount_minor).toBe(1_500_000);
    expect(salary.txn_date).toBe('2020-12-01');
    expect(salary.description).toBe('Salary');
    expect(salary.external_txn_id).toBe('01FRSAGN9VNWZXD7FY6A180XC2');

    const netflix = rows[1]!;
    expect(netflix.direction).toBe('outflow');
    // Positive in the column, negative only in `direction` — the schema checks
    // `amount_minor >= 0`, and one figure signed two different ways is how
    // totals stop adding up.
    expect(netflix.amount_minor).toBe(23_300);
  });

  it('never emits a negative amount, whatever the sign in the payload', () => {
    const { rows } = normalizeTransactions(VENDOR_TRANSACTIONS, { accountMap, currencyMap });
    for (const row of rows) expect(row.amount_minor).toBeGreaterThanOrEqual(0);
  });
});
