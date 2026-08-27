import { describe, expect, it } from 'vitest';
import { mapRowsToTransactions, parseCsv, suggestColumnMap } from '@/lib/connectors/csv';
import { parseFlexibleDate, lastCompleteMonths, addMonths, monthsInRange } from '@/lib/dates';

const BASE_OPTIONS = {
  accountId: '11111111-1111-1111-1111-111111111111',
  sourceSystem: 'csv_vn_bank' as const,
  defaultCurrency: 'VND',
  fileName: 'statement.csv',
};

describe('suggestColumnMap', () => {
  it('recognises English bank headers', () => {
    const map = suggestColumnMap(['Date', 'Description', 'Amount', 'Balance', 'Reference']);
    expect(map.date).toBe('Date');
    expect(map.description).toBe('Description');
    expect(map.amount).toBe('Amount');
    expect(map.reference).toBe('Reference');
  });

  it('recognises Vietnamese bank headers, with or without diacritics', () => {
    const map = suggestColumnMap(['Ngày giao dịch', 'Nội dung', 'Ghi Nợ', 'Ghi Có', 'Số dư']);
    expect(map.date).toBe('Ngày giao dịch');
    expect(map.description).toBe('Nội dung');
    expect(map.debit).toBe('Ghi Nợ');
    expect(map.credit).toBe('Ghi Có');
  });

  it('drops the amount guess when a debit/credit pair is present', () => {
    const map = suggestColumnMap(['Date', 'Debit', 'Credit', 'Amount']);
    expect(map.debit).toBe('Debit');
    expect(map.amount).toBeUndefined();
  });
});

describe('mapRowsToTransactions', () => {
  it('reads a VN statement: day-first dates, comma decimals, debit/credit pair', () => {
    const csv = `Ngày giao dịch,Nội dung,Ghi Nợ,Ghi Có
15/07/2026,Chuyen luong nhan vien,412.000.000,
18/07/2026,Thanh toan tu khach hang,,250.000.000`;

    const { headers, rows } = parseCsv(csv);
    expect(headers).toHaveLength(4);

    const result = mapRowsToTransactions(rows, suggestColumnMap(headers) as never, {
      ...BASE_OPTIONS,
      dayFirst: true,
      decimalSeparator: ',',
    });

    expect(result.errors).toHaveLength(0);
    expect(result.transactions).toHaveLength(2);

    const [payroll, revenue] = result.transactions;
    expect(payroll!.txn_date).toBe('2026-07-15');
    expect(payroll!.direction).toBe('outflow');
    expect(payroll!.amount_minor).toBe(412_000_000); // VND has no minor digits
    expect(revenue!.direction).toBe('inflow');
    expect(revenue!.amount_minor).toBe(250_000_000);
  });

  it('reads a US-style signed amount column', () => {
    const csv = `Date,Description,Amount
07/15/2026,Gusto payroll,-19400.00
07/18/2026,Client payment,"12,500.00"`;

    const { headers, rows } = parseCsv(csv);
    const result = mapRowsToTransactions(rows, suggestColumnMap(headers) as never, {
      ...BASE_OPTIONS,
      sourceSystem: 'manual',
      defaultCurrency: 'USD',
      dayFirst: false,
      decimalSeparator: '.',
    });

    expect(result.transactions[0]!.direction).toBe('outflow');
    expect(result.transactions[0]!.amount_minor).toBe(1_940_000);
    expect(result.transactions[1]!.direction).toBe('inflow');
    expect(result.transactions[1]!.amount_minor).toBe(1_250_000);
  });

  it('forces every row outward for a payroll export that drops the sign', () => {
    const csv = `Date,Employee,Amount
2026-07-15,Jomar Reyes,1200.00`;
    const { headers, rows } = parseCsv(csv);

    const result = mapRowsToTransactions(
      rows,
      { date: 'Date', counterparty: 'Employee', amount: 'Amount' },
      { ...BASE_OPTIONS, sourceSystem: 'csv_payroll', defaultCurrency: 'USD', forceDirection: 'outflow' },
    );
    expect(result.transactions[0]!.direction).toBe('outflow');
    expect(headers).toContain('Employee');
  });

  it('collects unreadable rows instead of importing them as zero', () => {
    const csv = `Date,Description,Amount
not-a-date,Broken row,100.00
2026-07-18,No amount here,
2026-07-19,Zero amount,0.00`;

    const { rows } = parseCsv(csv);
    const result = mapRowsToTransactions(
      rows,
      { date: 'Date', description: 'Description', amount: 'Amount' },
      { ...BASE_OPTIONS, sourceSystem: 'manual', defaultCurrency: 'USD' },
    );

    expect(result.transactions).toHaveLength(0);
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]!.rowNumber).toBe(2); // header is row 1
  });

  it('produces a stable id so re-importing the same file cannot double-count', () => {
    const csv = `Date,Description,Amount
2026-07-15,Payroll,-100.00`;
    const { rows } = parseCsv(csv);
    const map = { date: 'Date', description: 'Description', amount: 'Amount' };
    const options = { ...BASE_OPTIONS, sourceSystem: 'manual' as const, defaultCurrency: 'USD' };

    const first = mapRowsToTransactions(rows, map, options);
    const second = mapRowsToTransactions(rows, map, options);
    expect(first.transactions[0]!.external_txn_id).toBe(second.transactions[0]!.external_txn_id);
  });

  it('keeps two identical lines in one statement as two transactions', () => {
    // Two identical coffee purchases on the same day are real, not a duplicate.
    const csv = `Date,Description,Amount
2026-07-15,Cafe,-5.00
2026-07-15,Cafe,-5.00`;
    const { rows } = parseCsv(csv);
    const result = mapRowsToTransactions(
      rows,
      { date: 'Date', description: 'Description', amount: 'Amount' },
      { ...BASE_OPTIONS, sourceSystem: 'manual', defaultCurrency: 'USD' },
    );

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]!.external_txn_id).not.toBe(result.transactions[1]!.external_txn_id);
  });

  it('prefers the bank reference as the key when the file provides one', () => {
    const csv = `Date,Description,Amount,Ref
2026-07-15,Payroll,-100.00,TXN99871`;
    const { rows } = parseCsv(csv);
    const result = mapRowsToTransactions(
      rows,
      { date: 'Date', description: 'Description', amount: 'Amount', reference: 'Ref' },
      { ...BASE_OPTIONS, sourceSystem: 'manual', defaultCurrency: 'USD' },
    );
    expect(result.transactions[0]!.external_txn_id).toBe('manual:TXN99871');
  });
});

describe('date helpers', () => {
  it('reads ambiguous dates according to the day-first flag', () => {
    expect(parseFlexibleDate('03/04/2026', { dayFirst: false })).toBe('2026-03-04');
    expect(parseFlexibleDate('03/04/2026', { dayFirst: true })).toBe('2026-04-03');
  });

  it('reads an unambiguous day-first date correctly regardless of the flag', () => {
    expect(parseFlexibleDate('31/12/2026', { dayFirst: false })).toBe('2026-12-31');
  });

  it('returns null for junk rather than guessing', () => {
    expect(parseFlexibleDate('not a date')).toBeNull();
    expect(parseFlexibleDate('')).toBeNull();
  });

  it('walks back whole months without landing on the 3rd of March', () => {
    // Naive month arithmetic turns 2026-01-31 minus one month into March 3rd.
    expect(addMonths('2026-01-31', -1)).toBe('2025-12-31');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
  });

  it('bounds the burn window to complete months only', () => {
    const window = lastCompleteMonths('2026-08-15', 3);
    expect(window.from).toBe('2026-05-01');
    expect(window.to).toBe('2026-07-31');
    expect(monthsInRange(window)).toBe(3);
  });
});
