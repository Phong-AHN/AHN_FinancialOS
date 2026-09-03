import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildStatementRequest,
  isSuccess,
  normalizeStatement,
  parseDebitCredit,
  parseTransactionDate,
  parseTransactionTime,
  toRequestDate,
  toTransTime,
  vietinbankBase,
  vietinbankConfigProblems,
  vietinbankConfigured,
  vietinbankEnvironment,
  type StatementResponse,
} from '@/lib/connectors/vietinbank';

const KEYS = [
  'VIETINBANK_CLIENT_ID',
  'VIETINBANK_CLIENT_SECRET',
  'VIETINBANK_ACCOUNT_NUMBER',
  'VIETINBANK_PROVIDER_ID',
  'VIETINBANK_MERCHANT_ID',
  'VIETINBANK_ENV',
  'VIETINBANK_API_BASE',
  'VIETINBANK_ACCOUNT_TYPE',
  'VIETINBANK_CHANNEL',
  'VIETINBANK_MODEL',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Exactly the response printed in the bank's own documentation. */
const DOC_RESPONSE: StatementResponse = {
  requestId: '343q433410001',
  providerId: 'khaianh',
  merchantId: 'VHTEST9',
  status: { code: '1', message: 'Thanh cong' },
  account: '114000121964',
  companyName: 'Customer Name',
  accountType: 'D',
  curency: 'VND',
  accountBal: '7135.00',
  availableBal: '7135',
  openningBal: '21816502',
  closingBal: '14624492',
  fromDate: '07/09/2021',
  toDate: '17/09/2021',
  totalCredit: '0',
  numberCreditTransaction: '0',
  totalDebit: '7192010.00',
  numberDebitTransaction: '99',
  transactions: [
    {
      order: '1',
      transactionDate: '16-09-2021 06:00:29',
      transactionContent: 'Vananh ERP in',
      mtId: '',
      debit: '15000',
      credit: '',
      accountBal: '14624492.00',
      transactionNumber: '1lAfM-7TLoiNEt2',
      corresponsiveAccount: '119002808456',
      corresponsiveAccountName: 'CT HOANG HA NGUYEN',
      agency: { account: '119002808456', branchCode: '11111', name: '', productType: '', productName: '' },
      virtualAccount: '119002808456',
      corresponsiveBankName: '',
      corresponsiveBankId: '24898',
      serviceBranchId: '60098',
      serviceBankName: '',
      channel: '77 - eFAST - Corporate Internet Banking',
    },
  ],
} as StatementResponse;

describe("the bank's own example response", () => {
  it('is recognised as successful', () => {
    // "1" means success here. Every other system in this codebase treats 0 that
    // way, and a `!code` check would read a missing status as a success.
    expect(isSuccess(DOC_RESPONSE)).toBe(true);
    expect(isSuccess({ status: { code: '0', message: 'That would be a failure' } })).toBe(false);
    expect(isSuccess({})).toBe(false);
  });

  it('turns the documented transaction into exactly one ledger row', () => {
    const { rows, skippedNoDate, skippedNoAmount } = normalizeStatement(DOC_RESPONSE, {
      accountId: 'our-account',
    });

    expect(skippedNoDate + skippedNoAmount).toBe(0);
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.txn_date).toBe('2021-09-16');
    expect(row.posted_at).toBe('2021-09-16T06:00:29Z');
    expect(row.direction).toBe('outflow'); // it is a debit
    expect(row.amount_minor).toBe(15_000); // VND has no minor unit
    expect(row.currency).toBe('VND');
    expect(row.description).toBe('Vananh ERP in');
    expect(row.counterparty_name).toBe('CT HOANG HA NGUYEN');
    expect(row.source_system).toBe('vietinbank');
    // Scoped by account: the unique index is on external id alone, and the same
    // bank reference could recur on a different account.
    expect(row.external_txn_id).toBe('114000121964:1lAfM-7TLoiNEt2');
  });

  it('reads the currency out of the misspelled field the bank actually sends', () => {
    // The specification says `curency`, not `currency`. Matching the correct
    // spelling would silently fall back to the default on every statement.
    expect(normalizeStatement({ ...DOC_RESPONSE, curency: 'USD' }, { accountId: 'a' }).rows[0]!.currency).toBe(
      'USD',
    );
  });
});

describe('parseDebitCredit', () => {
  it('reads a debit as money out and a credit as money in', () => {
    expect(parseDebitCredit({ debit: '15000', credit: '' }, 'VND')).toEqual({
      minor: 15_000,
      direction: 'outflow',
    });
    expect(parseDebitCredit({ debit: null, credit: '430000000' }, 'VND')).toEqual({
      minor: 430_000_000,
      direction: 'inflow',
    });
  });

  it('handles the decimals the bank sends on a currency that has none', () => {
    // "7192010.00" is a dong figure with two decimal places attached. The
    // currency drives the scaling, not a fixed x100.
    expect(parseDebitCredit({ debit: '7192010.00' }, 'VND')?.minor).toBe(7_192_010);
    expect(parseDebitCredit({ debit: '1833.22' }, 'USD')?.minor).toBe(183_322);
  });

  it('refuses a row with both columns filled', () => {
    // Booking half of an unreadable row would put a real amount in the ledger
    // pointing the wrong way.
    expect(parseDebitCredit({ debit: '100', credit: '200' }, 'VND')).toBeNull();
  });

  it('refuses a row with neither', () => {
    expect(parseDebitCredit({ debit: '', credit: null }, 'VND')).toBeNull();
    expect(parseDebitCredit({}, 'VND')).toBeNull();
  });

  it('treats a padded zero as no value rather than as a transaction', () => {
    // Some statements pad both columns. A zero is a real number and not a
    // transaction; counting it would create a phantom row on every line.
    expect(parseDebitCredit({ debit: '0', credit: '5000' }, 'VND')).toEqual({
      minor: 5_000,
      direction: 'inflow',
    });
  });
});

describe('the two date formats', () => {
  it('sends slashes and reads hyphens', () => {
    // The request uses DD/MM/YYYY, the response DD-MM-YYYY. Getting them the
    // wrong way round is answered with an empty statement, not an error.
    expect(toRequestDate('2026-07-05')).toBe('05/07/2026');
    expect(parseTransactionDate('16-09-2021 06:00:29')).toBe('2021-09-16');
  });

  it('refuses to guess at an unfamiliar date', () => {
    // A transaction on the wrong day lands in the wrong month, and a month-end
    // figure is exactly what gets reported to a bank or a board.
    for (const raw of ['2021-09-16', '16/09/2021', 'yesterday', '', null, undefined]) {
      expect(parseTransactionDate(raw), String(raw)).toBeNull();
    }
  });

  it('keeps the time when there is one, and says null when there is not', () => {
    expect(parseTransactionTime('16-09-2021 06:00:29')).toBe('2021-09-16T06:00:29Z');
    expect(parseTransactionTime('16-09-2021')).toBeNull();
  });

  it('formats transTime as YYYYMMDDHHmmss', () => {
    expect(toTransTime(new Date(Date.UTC(2021, 8, 15, 5, 1, 1)))).toBe('20210915050101');
  });
});

describe('buildStatementRequest', () => {
  beforeEach(() => {
    process.env.VIETINBANK_ACCOUNT_NUMBER = '114000121964';
    process.env.VIETINBANK_PROVIDER_ID = 'ahn';
    process.env.VIETINBANK_MERCHANT_ID = 'AHNTEST';
  });

  it('never sends collectionType', () => {
    // The single most expensive field to copy from the example. It filters the
    // statement to debits OR credits — the example value is "d" — so sending it
    // would return only money going out, and the ledger would be missing every
    // payment received while looking perfectly complete.
    const body = buildStatementRequest({ from: '2026-07-01', to: '2026-07-31' });
    expect(body.collectionType).toBeUndefined();
  });

  it('covers the whole day at both ends', () => {
    const body = buildStatementRequest({ from: '2026-07-01', to: '2026-07-31' });
    expect(body.fromDate).toBe('01/07/2026');
    expect(body.toDate).toBe('31/07/2026');
    expect(body.fromTime).toBe('00:00:00');
    expect(body.toTime).toBe('23:59:59');
  });

  it('gives every call its own requestId', () => {
    // The bank treats it as the partner's reference; reusing one is how a retry
    // gets mistaken for a duplicate.
    const a = buildStatementRequest({ from: '2026-07-01', to: '2026-07-31' });
    const b = buildStatementRequest({ from: '2026-07-01', to: '2026-07-31' });
    expect(a.requestId).not.toBe(b.requestId);
    expect(a.requestId!.length).toBeLessThanOrEqual(30); // the spec maxLength
  });

  it('respects every maxLength the specification declares', () => {
    const limits: Record<string, number> = {
      model: 5,
      requestId: 30,
      providerId: 25,
      merchantId: 25,
      account: 30,
      fromDate: 20,
      toDate: 20,
      fromTime: 20,
      toTime: 20,
      accountType: 1,
      transTime: 14,
      channel: 15,
      version: 5,
      language: 3,
    };
    const body = buildStatementRequest({ from: '2026-07-01', to: '2026-07-31' });
    for (const [field, max] of Object.entries(limits)) {
      if (body[field] === undefined) continue;
      expect(body[field]!.length, `${field} = "${body[field]}"`).toBeLessThanOrEqual(max);
    }
  });
});

describe('configuration', () => {
  it('names every missing thing, including the partner identifiers', () => {
    // A wrong providerId or merchantId is answered with a status code rather
    // than an HTTP error, so it fails silently unless something looks.
    const joined = vietinbankConfigProblems().join(' ');
    expect(joined).toContain('VIETINBANK_CLIENT_ID');
    expect(joined).toContain('VIETINBANK_CLIENT_SECRET');
    expect(joined).toContain('VIETINBANK_ACCOUNT_NUMBER');
    expect(joined).toContain('VIETINBANK_PROVIDER_ID');
    expect(joined).toContain('VIETINBANK_MERCHANT_ID');
  });

  it('is satisfied by the five values the sandbox needs', () => {
    process.env.VIETINBANK_CLIENT_ID = 'id';
    process.env.VIETINBANK_CLIENT_SECRET = 'secret';
    process.env.VIETINBANK_ACCOUNT_NUMBER = '114000121964';
    process.env.VIETINBANK_PROVIDER_ID = 'ahn';
    process.env.VIETINBANK_MERCHANT_ID = 'AHNTEST';

    expect(vietinbankConfigured()).toBe(true);
    expect(vietinbankConfigProblems()).toHaveLength(0);
  });

  it('defaults to the sandbox host from the specification', () => {
    expect(vietinbankEnvironment()).toBe('sandbox');
    expect(vietinbankBase()).toBe('https://sandbox.vietinbank.vn/vtb/openbanking/erp/v1/statement');
  });

  it('refuses to invent a production address', () => {
    // The specification lists the sandbox URL for both "production" and
    // "development", which cannot both be right — so production has to be told.
    process.env.VIETINBANK_CLIENT_ID = 'id';
    process.env.VIETINBANK_CLIENT_SECRET = 'secret';
    process.env.VIETINBANK_ACCOUNT_NUMBER = '1';
    process.env.VIETINBANK_PROVIDER_ID = 'a';
    process.env.VIETINBANK_MERCHANT_ID = 'b';
    process.env.VIETINBANK_ENV = 'production';

    expect(vietinbankConfigProblems().join(' ')).toContain('no production address');
  });

  it('stays on sandbox for any unrecognised environment', () => {
    for (const value of ['prod', 'PRODUCTION', 'uat', '']) {
      process.env.VIETINBANK_ENV = value;
      expect(vietinbankEnvironment(), value).toBe('sandbox');
    }
  });
});

describe('the documentation placeholder', () => {
  it('is caught before a request is ever sent', () => {
    // The Swagger document describes both credential headers as "apiKey located
    // in header". Pasted into an env file that is a plausible 24-character
    // string that looks like a key. The gateway answers it with the same 401 as
    // a genuinely wrong secret, so without this check nothing on screen would
    // distinguish "I copied the wrong line" from "my key expired".
    process.env.VIETINBANK_CLIENT_ID = 'apiKey located in header';
    process.env.VIETINBANK_CLIENT_SECRET = 'apiKey located in header';
    process.env.VIETINBANK_ACCOUNT_NUMBER = '114000121964';
    process.env.VIETINBANK_PROVIDER_ID = 'khaianh';
    process.env.VIETINBANK_MERCHANT_ID = 'VHTEST9';

    const problems = vietinbankConfigProblems();
    expect(problems).toHaveLength(2);
    expect(problems.join(' ')).toContain('parameter description');
  });

  it('does not fire on a real-looking key', () => {
    process.env.VIETINBANK_CLIENT_ID = '7f3a9c21-4e18-4b6d-9a02-5c8e11d7b430';
    process.env.VIETINBANK_CLIENT_SECRET = 'sV2mQ8xLp4Rt';
    process.env.VIETINBANK_ACCOUNT_NUMBER = '114000121964';
    process.env.VIETINBANK_PROVIDER_ID = 'khaianh';
    process.env.VIETINBANK_MERCHANT_ID = 'VHTEST9';

    expect(vietinbankConfigProblems()).toHaveLength(0);
  });
});
