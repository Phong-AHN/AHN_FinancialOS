/**
 * Generic CSV import - MVP Plan Day 1 (import module) and Day 6 (real VN bank,
 * VEEM and payroll files).
 *
 * These three sources have no self-serve API (MVP Plan section 1), so CSV is
 * how AHN Vietnamese and Philippine money reaches the dashboard in week 1.
 * They still flow through the same `transactions` table as the API sources -
 * that is the whole point of the shared ingest path, and it is why swapping in
 * a real VEEM API later touches only one file.
 *
 * The mapper handles the two shapes bank exports actually come in:
 *   - one signed amount column (US style)
 *   - separate debit and credit columns (VN bank and VEEM style)
 */

import Papa from 'papaparse';
import { parseAmountToMinor } from '@/lib/money';
import { parseFlexibleDate } from '@/lib/dates';
import type { NormalizedTransaction, SourceSystem, TxnDirection } from '@/lib/types';

export interface ParsedCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
}

export function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<Record<string, string>>(text.trim(), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });
  return {
    headers: result.meta.fields ?? [],
    rows: (result.data ?? []).filter((r) => Object.values(r).some((v) => v && String(v).trim())),
  };
}

export interface ColumnMap {
  date: string;
  description?: string;
  /** One signed amount column... */
  amount?: string;
  /** ...or a debit/credit pair. */
  debit?: string;
  credit?: string;
  counterparty?: string;
  category?: string;
  currency?: string;
  reference?: string;
  balance?: string;
}

export interface MapOptions {
  accountId: string;
  sourceSystem: SourceSystem;
  /** Fallback when the file has no currency column. */
  defaultCurrency: string;
  /** VN and most non-US statements are DD/MM/YYYY. */
  dayFirst?: boolean;
  /** VN exports often use "1.234.567,89". */
  decimalSeparator?: '.' | ',';
  /**
   * For a single-amount file where the export drops the sign, e.g. a payroll
   * run that lists positive amounts that are all money going out.
   */
  forceDirection?: TxnDirection;
  manualImportId?: string;
  fileName: string;
}

export interface RowError {
  rowNumber: number;
  reason: string;
  raw: Record<string, string>;
}

export interface MapResult {
  transactions: NormalizedTransaction[];
  errors: RowError[];
}

/**
 * Turn mapped CSV rows into normalized transactions.
 *
 * A row that cannot be read is pushed to `errors` and NEVER silently dropped or
 * booked as zero - spec section 22 requires an unmatched queue rather than a
 * quietly wrong total.
 */
export function mapRowsToTransactions(
  rows: Array<Record<string, string>>,
  map: ColumnMap,
  options: MapOptions,
): MapResult {
  const transactions: NormalizedTransaction[] = [];
  const errors: RowError[] = [];

  rows.forEach((raw, index) => {
    const rowNumber = index + 2; // +1 for the header, +1 for 1-based counting

    const txnDate = parseFlexibleDate(raw[map.date], { dayFirst: options.dayFirst });
    if (!txnDate) {
      errors.push({ rowNumber, reason: `Unreadable date in "${map.date}"`, raw });
      return;
    }

    const currency = (map.currency ? raw[map.currency] : '')?.trim().toUpperCase() || options.defaultCurrency;

    let amountMinor: number | null = null;
    let direction: TxnDirection | null = null;

    if (map.debit || map.credit) {
      const debit = map.debit ? parseAmountToMinor(raw[map.debit], currency, options) : null;
      const credit = map.credit ? parseAmountToMinor(raw[map.credit], currency, options) : null;

      if (debit && debit !== 0) {
        amountMinor = Math.abs(debit);
        direction = 'outflow';
      } else if (credit && credit !== 0) {
        amountMinor = Math.abs(credit);
        direction = 'inflow';
      }
    } else if (map.amount) {
      const signed = parseAmountToMinor(raw[map.amount], currency, options);
      if (signed !== null) {
        amountMinor = Math.abs(signed);
        direction = options.forceDirection ?? (signed < 0 ? 'outflow' : 'inflow');
      }
    }

    if (amountMinor === null || direction === null) {
      errors.push({ rowNumber, reason: 'No usable amount on this row', raw });
      return;
    }
    if (amountMinor === 0) {
      errors.push({ rowNumber, reason: 'Amount is zero', raw });
      return;
    }

    const description = (map.description ? raw[map.description] : '')?.trim() || null;
    const counterparty = (map.counterparty ? raw[map.counterparty] : '')?.trim() || null;
    const reference = (map.reference ? raw[map.reference] : '')?.trim() || null;

    transactions.push({
      account_id: options.accountId,
      txn_date: txnDate,
      amount_minor: amountMinor,
      currency,
      direction,
      description,
      counterparty_name: counterparty ?? description,
      category: (map.category ? raw[map.category] : '')?.trim() || undefined,
      source_system: options.sourceSystem,
      // A bank reference is the stable key when the file has one. Otherwise the
      // fingerprint below makes re-importing the same file idempotent: same
      // file, same rows, same ids, so nothing double-counts.
      external_txn_id: reference
        ? `${options.sourceSystem}:${reference}`
        : fingerprint(options.fileName, txnDate, amountMinor, direction, description, rowNumber),
      manual_import_id: options.manualImportId ?? null,
      raw,
    });
  });

  return { transactions, errors };
}

/**
 * Stable per-row id for files with no reference column.
 *
 * Includes the row number so two genuinely identical lines in one statement -
 * a real thing, e.g. two identical coffee purchases the same day - both survive
 * instead of collapsing into one.
 */
function fingerprint(
  fileName: string,
  date: string,
  amountMinor: number,
  direction: string,
  description: string | null,
  rowNumber: number,
): string {
  const base = [fileName, date, amountMinor, direction, description ?? '', rowNumber].join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < base.length; i++) {
    hash ^= base.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `csv:${hash.toString(16)}:${date}:${amountMinor}`;
}

// ─── Header auto-detection ──────────────────────────────────────────────────

/**
 * Header aliases, including the Vietnamese ones on VN bank statements.
 *
 * The short Vietnamese words for debit and credit ("nợ" and "có") are anchored
 * as whole headers rather than prefixes. As a bare prefix, "no" matches "Nội
 * dung" (description) and "co" matches almost anything - which silently maps
 * the description column as the debit column and imports a statement of zeros.
 */
const PATTERNS: Record<keyof ColumnMap, RegExp> = {
  date: /^(date|txn.?date|transaction.?date|posted|posting.?date|value.?date|ngay|ngay.?(giao.?dich|gd)|thoi.?gian)/i,
  description: /^(description|details|memo|narrative|particulars|note|remark|noi.?dung|dien.?giai|mo.?ta)/i,
  amount: /^(amount|value|sum|so.?tien|net)\b|^amount/i,
  debit: /^(debit|withdrawal|withdrawn|paid.?out|money.?out|outflow|ghi.?no|phat.?sinh.?no)\b|^no$/i,
  credit: /^(credit|deposit|paid.?in|money.?in|inflow|ghi.?co|phat.?sinh.?co)\b|^co$/i,
  counterparty: /^(payee|merchant|vendor|customer|counterparty|recipient|beneficiary|name|nguoi.?(nhan|gui)|doi.?tac)/i,
  category: /^(category|type|classification|loai)/i,
  currency: /^(currency|ccy|curr|don.?vi|loai.?tien)/i,
  reference: /^(reference|ref|ref.?no|transaction.?id|txn.?id|so.?tham.?chieu|ma.?gd)\b|^id$/i,
  balance: /^(balance|running.?balance|closing.?balance|so.?du)/i,
};

/** Best-effort column mapping to pre-fill the import UI. Always user-editable. */
export function suggestColumnMap(headers: string[]): Partial<ColumnMap> {
  const suggestion: Partial<ColumnMap> = {};
  const normalized = headers.map((h) => ({ raw: h, clean: stripDiacritics(h).trim() }));

  for (const [field, pattern] of Object.entries(PATTERNS) as Array<[keyof ColumnMap, RegExp]>) {
    const hit = normalized.find((h) => pattern.test(h.clean));
    if (hit) suggestion[field] = hit.raw;
  }

  // A file with debit/credit columns does not also need the amount column; a
  // balance column often matches /amount/ and would map wrongly.
  if (suggestion.debit || suggestion.credit) delete suggestion.amount;
  if (suggestion.amount && suggestion.amount === suggestion.balance) delete suggestion.amount;

  return suggestion;
}

/** "Ngày giao dịch" -> "Ngay giao dich", so one pattern set covers both. */
function stripDiacritics(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

/** Presets for the three sources the MVP plan imports by hand. */
export const CSV_PRESETS: Record<
  string,
  { label: string; sourceSystem: SourceSystem; dayFirst: boolean; decimalSeparator: '.' | ','; defaultCurrency: string; hint: string }
> = {
  vn_bank: {
    label: 'Vietnamese bank statement',
    sourceSystem: 'csv_vn_bank',
    dayFirst: true,
    decimalSeparator: ',',
    defaultCurrency: 'VND',
    hint: 'Usually DD/MM/YYYY with separate Ghi Nợ / Ghi Có columns.',
  },
  veem: {
    label: 'VEEM payment history',
    sourceSystem: 'csv_veem',
    dayFirst: false,
    decimalSeparator: '.',
    defaultCurrency: 'USD',
    hint: 'Philippines payroll runs. Amounts are outgoing.',
  },
  payroll: {
    label: 'Payroll export',
    sourceSystem: 'csv_payroll',
    dayFirst: false,
    decimalSeparator: '.',
    defaultCurrency: 'USD',
    hint: 'Gusto / Deel / ADP / spreadsheet. All rows are money out.',
  },
  generic: {
    label: 'Other CSV',
    sourceSystem: 'manual',
    dayFirst: false,
    decimalSeparator: '.',
    defaultCurrency: 'USD',
    hint: 'Map the columns by hand.',
  },
};
