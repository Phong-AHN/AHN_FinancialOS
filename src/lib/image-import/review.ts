import { parseAmount, toMinor } from '@/lib/money';
import type { TxnDirection } from '@/lib/types';

/**
 * Turning a model's reading of a bank screenshot into rows a person can check.
 *
 * PURE, and shared by the server and the browser: the server validates each
 * screenshot as it is read, the browser merges several screenshots of one
 * scrolling list, and the commit route re-runs the same rules on whatever the
 * person finally approves. Nothing here talks to the model or the database.
 *
 * THE MODEL IS A READER, NOT AN AUTHORITY. Every figure it returns is checked
 * against something else it returned:
 *
 *   - the amount as a number against the amount as printed, character for
 *     character ("6,500,000 VND" must be 6,500,000 — a misread digit shows up
 *     as a disagreement between the two, not as a plausible wrong figure);
 *   - the direction against any sign on the screen;
 *   - the date against the calendar and against today;
 *   - the status against the words the bank actually uses.
 *
 * Anything that fails is shown to the person and left out unless they fix it.
 * A money-moving misread that nobody sees is the one outcome this file exists
 * to prevent.
 */

/** One card or line, as the model transcribed it. Mirrors the output schema. */
export interface ScreenshotRow {
  reference: string | null;
  transfer_type: string | null;
  amount_text: string;
  amount: number;
  currency: string;
  direction: TxnDirection;
  direction_evidence: string;
  counterparty_name: string | null;
  counterparty_bank: string | null;
  counterparty_account: string | null;
  description: string | null;
  datetime_text: string | null;
  status_text: string | null;
  cut_off: boolean;
}

/** One whole screenshot, as the model read it. */
export interface ScreenshotReading {
  bank: string | null;
  screen_title: string | null;
  tab: string | null;
  is_transaction_list: boolean;
  shows_posted_transactions: boolean;
  rows: ScreenshotRow[];
}

/**
 * Why a row cannot be imported as it stands. All but `cut_off` and
 * `readings_differ` block the row until a person corrects it.
 */
export type RowIssue =
  | 'amount_mismatch'
  | 'no_amount'
  | 'currency_mismatch'
  | 'direction_mismatch'
  | 'no_datetime'
  | 'bad_datetime'
  | 'future_date'
  | 'not_successful'
  | 'unknown_status'
  | 'already_imported'
  | 'cut_off'
  | 'readings_differ';

const INFORMATIONAL: ReadonlySet<RowIssue> = new Set(['cut_off', 'readings_differ']);

export const ISSUE_TEXT: Record<RowIssue, string> = {
  amount_mismatch: 'The amount read does not match the amount printed — check it against the screenshot.',
  no_amount: 'No readable amount.',
  currency_mismatch: 'This amount is in a different currency from the account, so it cannot be saved into it.',
  direction_mismatch: 'The sign on screen contradicts the direction — check whether money came in or went out.',
  no_datetime: 'No date on this row.',
  bad_datetime: 'The date could not be read as a real day.',
  future_date: 'The date is in the future — probably a misread year.',
  not_successful: 'The bank shows this as not completed, so no money moved.',
  unknown_status: 'The status is not one the bank normally shows — confirm the money actually moved.',
  already_imported: 'Already imported from an earlier screenshot.',
  cut_off: 'Partly off the edge of the screenshot.',
  readings_differ: 'Two screenshots showed this row slightly differently; the more complete reading is used.',
};

export interface ReviewRow {
  /** Stable identity of the transaction — see `rowKey`. */
  key: string;
  /** Which uploaded screenshots showed it (0-based, in upload order). */
  images: number[];
  reference: string | null;
  transferType: string | null;
  amountText: string;
  amountMinor: number | null;
  currency: string;
  direction: TxnDirection;
  directionEvidence: string;
  counterpartyName: string | null;
  counterpartyBank: string | null;
  counterpartyAccount: string | null;
  description: string | null;
  datetimeText: string | null;
  /** YYYY-MM-DD, in the bank's own (Vietnam) calendar. */
  txnDate: string | null;
  /** HH:MM:SS, or HH:MM when the screen shows no seconds. */
  time: string | null;
  statusText: string | null;
  /** The screen is a posted-transaction history, where rows carry no status. */
  postedScreen: boolean;
  cutOff: boolean;
  issues: RowIssue[];
  /**
   * The model that actually read it. Usually the one asked for, but a
   * server-side fallback can answer instead, and the audit trail should say so.
   */
  readBy?: string | null;
}

export function blocking(row: Pick<ReviewRow, 'issues'>): RowIssue[] {
  return row.issues.filter((i) => !INFORMATIONAL.has(i));
}

export function importable(row: Pick<ReviewRow, 'issues'>): boolean {
  return blocking(row).length === 0;
}

// ─── Amounts ────────────────────────────────────────────────────────────────

/**
 * The amount exactly as printed, in minor units, with any sign it carried.
 *
 * Built on the same `parseAmount` the CSV importer uses, so "6,500,000" and
 * "6.500.000" and "6,500,000.00" mean one thing everywhere in this system.
 */
export function parseScreenAmount(
  text: string,
  currency: string,
): { minor: number; sign: 1 | -1 | 0 } | null {
  const trimmed = text.trim();
  const sign: 1 | -1 | 0 = /^[+]/.test(trimmed) ? 1 : /^[-−–]/.test(trimmed) ? -1 : 0;
  // A typographic minus is not a hyphen; parseAmount only knows the hyphen.
  // And Vietnamese apps write the currency as "đ", "VNĐ" or "đồng" as often as
  // "VND" — parseAmount knows only the last, and "6.500.000 đ" read as nothing.
  const cleaned = trimmed.replace(/^[−–]/, '-').replace(/VNĐ|VND|đồng|₫|đ/gi, '').trim();
  const major = parseAmount(cleaned, { currency });
  if (major === null || major === 0) return null;
  return { minor: toMinor(Math.abs(major), currency), sign };
}

/** Currency from the printed amount, falling back to what the model said. */
export function currencyOf(amountText: string, modelCurrency: string): string {
  // Not \bđ\b: \b only knows ASCII letters, so it never matched "6.500.000 đ".
  if (/VND|VNĐ|₫|đồng|(^|[\s\d])đ(?=\s|$)/i.test(amountText)) return 'VND';
  if (/USD|\$/.test(amountText)) return 'USD';
  return (modelCurrency || 'VND').trim().toUpperCase().replace('VNĐ', 'VND');
}

// ─── Dates ──────────────────────────────────────────────────────────────────

/**
 * "30/08/2026 16:29:12" → 2026-08-30 and 16:29:12.
 *
 * Vietnamese banks print day/month/year. A date that does not exist on the
 * calendar (31/02) is refused rather than rolled into March the way `Date`
 * would quietly do.
 */
export function parseScreenDateTime(
  text: string | null,
): { date: string; time: string | null } | null {
  if (!text) return null;
  const m = text
    .trim()
    .match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, d, mo, y, hh, mi, ss] = m;
  const day = Number(d);
  const month = Number(mo);
  const year = Number(y);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  const date = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (hh === undefined) return { date, time: null };
  if (Number(hh) > 23 || Number(mi) > 59 || (ss !== undefined && Number(ss) > 59)) return null;
  const time = `${hh!.padStart(2, '0')}:${mi}${ss !== undefined ? `:${ss}` : ''}`;
  return { date, time };
}

/** ISO timestamp in Vietnam time — the zone every VietinBank screen shows. */
export function postedAtOf(date: string, time: string | null): string | null {
  if (!time) return null;
  const [h, m, s = '00'] = time.split(':');
  return `${date}T${h}:${m}:${s}+07:00`;
}

// ─── Status ─────────────────────────────────────────────────────────────────

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();

const SUCCESS = ['thanh cong', 'giao dich thanh cong', 'hoan thanh', 'da hoan thanh', 'success', 'successful', 'completed'];
const NOT_SUCCESS = [
  'that bai',
  'khong thanh cong',
  'bi tu choi',
  'tu choi',
  'da huy',
  'huy',
  'dang xu ly',
  'cho xu ly',
  'cho duyet',
  'can duyet',
  'cho phe duyet',
  'failed',
  'rejected',
  'cancelled',
  'pending',
  'processing',
  // VietinBank's own words for requests that did not complete.
  'da tu choi',
  'het han',
  'da het han',
  'loi',
  'giao dich loi',
  'cho xac nhan',
  'chua duyet',
  'khong hop le',
];

/**
 * Did money actually move?
 *
 * Only the words the bank uses for a completed transfer count. A request that
 * is approved but still processing, rejected or cancelled moved nothing, and a
 * status nobody recognises is not guessed at. On a posted-transaction history
 * every line has already happened, so no status there is fine.
 */
export function statusOf(
  statusText: string | null,
  postedScreen: boolean,
): 'successful' | 'not_successful' | 'unknown' {
  if (!statusText || !statusText.trim()) return postedScreen ? 'successful' : 'unknown';
  const s = fold(statusText);
  if (NOT_SUCCESS.some((w) => s === w || s.startsWith(`${w} `))) return 'not_successful';
  if (SUCCESS.some((w) => s === w || s.startsWith(`${w} `))) return 'successful';
  return 'unknown';
}

// ─── Identity ───────────────────────────────────────────────────────────────

const slug = (s: string | null) =>
  s ? fold(s).replace(/[^a-z0-9]+/g, '').slice(0, 24) : '';

/**
 * A transaction's identity, stable across screenshots and across imports.
 *
 * It is built from what the bank printed, never from where the card sat on the
 * screen, so the same transfer in two overlapping screenshots — or imported
 * twice by mistake — gets the same key and is kept once.
 *
 * To the second, date + time + direction + amount is unique in practice, and
 * crucially it does not depend on the transaction number: in a scrolling list
 * the card at the top is often cut off ABOVE its number, while the next
 * screenshot shows it whole. Where the screen shows no seconds (or no time),
 * the number, the counterparty account or the counterparty name is added so
 * two same-sized payments on one day stay two.
 */
export function rowKey(row: {
  txnDate: string | null;
  time: string | null;
  direction: TxnDirection;
  amountMinor: number | null;
  reference: string | null;
  counterpartyAccount: string | null;
  counterpartyName: string | null;
  description: string | null;
}): string {
  const stamp = `${(row.txnDate ?? 'nodate').replace(/-/g, '')}${(row.time ?? '').replace(/:/g, '')}`;
  const base = `${stamp}:${row.direction === 'inflow' ? 'i' : 'o'}:${row.amountMinor ?? 'na'}`;
  const hasSeconds = /^\d{2}:\d{2}:\d{2}$/.test(row.time ?? '');
  if (hasSeconds) return base;
  const tail =
    (row.reference && slug(row.reference)) ||
    (row.counterpartyAccount && row.counterpartyAccount.replace(/\D/g, '').slice(-8)) ||
    slug(row.counterpartyName) ||
    slug(row.description) ||
    'x';
  return `${base}:${tail}`;
}

/** The ledger id. Scoped to the account, so two accounts can never collide. */
export function externalIdFor(accountId: string, key: string): string {
  return `img:${accountId.slice(0, 8)}:${key}`;
}

// ─── One screenshot ─────────────────────────────────────────────────────────

export function reviewScreenshot(
  reading: ScreenshotReading,
  imageIndex: number,
  opts: { today: string },
): ReviewRow[] {
  if (!reading.is_transaction_list) return [];
  const tomorrow = new Date(`${opts.today}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const latest = tomorrow.toISOString().slice(0, 10);

  return reading.rows.map((r) => {
    const issues: RowIssue[] = [];
    const currency = currencyOf(r.amount_text, r.currency);

    const printed = parseScreenAmount(r.amount_text, currency);
    let amountMinor: number | null = null;
    if (!printed) {
      issues.push('no_amount');
    } else {
      amountMinor = printed.minor;
      const told = Number.isFinite(r.amount) ? toMinor(Math.abs(r.amount), currency) : NaN;
      if (told !== printed.minor) issues.push('amount_mismatch');
      if ((printed.sign === 1 && r.direction === 'outflow') || (printed.sign === -1 && r.direction === 'inflow')) {
        issues.push('direction_mismatch');
      }
    }

    const when = parseScreenDateTime(r.datetime_text);
    if (!r.datetime_text) issues.push('no_datetime');
    else if (!when) issues.push('bad_datetime');
    else if (when.date > latest) issues.push('future_date');

    const status = statusOf(r.status_text, reading.shows_posted_transactions);
    if (status === 'not_successful') issues.push('not_successful');
    if (status === 'unknown') issues.push('unknown_status');
    if (r.cut_off) issues.push('cut_off');

    const row: Omit<ReviewRow, 'key'> = {
      images: [imageIndex],
      reference: r.reference?.trim() || null,
      transferType: r.transfer_type?.trim() || null,
      amountText: r.amount_text,
      amountMinor,
      currency,
      direction: r.direction,
      directionEvidence: r.direction_evidence,
      counterpartyName: r.counterparty_name?.trim() || null,
      counterpartyBank: r.counterparty_bank?.trim() || null,
      counterpartyAccount: r.counterparty_account?.trim() || null,
      description: r.description?.trim() || null,
      datetimeText: r.datetime_text,
      txnDate: when?.date ?? null,
      time: when?.time ?? null,
      statusText: r.status_text?.trim() || null,
      postedScreen: reading.shows_posted_transactions,
      cutOff: r.cut_off,
      issues,
    };
    return { ...row, key: rowKey(row) };
  });
}

// ─── Several screenshots of one list ────────────────────────────────────────

function completeness(r: ReviewRow): number {
  const fields = [r.reference, r.counterpartyName, r.counterpartyAccount, r.description, r.statusText, r.time];
  return (r.reference ? 10 : 0) + (r.cutOff ? 0 : 5) - blocking(r).length * 20 + fields.filter(Boolean).length;
}

/**
 * One row per transaction across every screenshot, in the order they appeared.
 *
 * The best reading wins — the one that shows the transaction number, is not
 * cut off, and has the fewest problems. If two readings of the same
 * transaction disagree about a name or a description, the person is told.
 */
export function mergeReviewRows(rows: ReviewRow[]): ReviewRow[] {
  const groups = new Map<string, ReviewRow[]>();
  for (const r of rows) {
    const g = groups.get(r.key);
    if (g) g.push(r);
    else groups.set(r.key, [r]);
  }
  const merged: ReviewRow[] = [];
  for (const group of groups.values()) {
    const best = [...group].sort((a, b) => completeness(b) - completeness(a))[0]!;
    const images = [...new Set(group.flatMap((r) => r.images))].sort((a, b) => a - b);
    const differ = group.some(
      (r) =>
        (r.counterpartyName ?? '') !== (best.counterpartyName ?? '') ||
        (r.description ?? '') !== (best.description ?? ''),
    );
    // A cut-off card seen whole in another screenshot is not cut off any more.
    const issues = best.issues.filter((i) => i !== 'cut_off' || group.every((r) => r.cutOff));
    if (differ && !issues.includes('readings_differ')) issues.push('readings_differ');
    merged.push({ ...best, images, issues, cutOff: group.every((r) => r.cutOff) });
  }

  /*
   * A card cut off at the bottom of one screenshot can show its amount but not
   * its date. With no date it cannot share a key with the same card seen whole
   * in the next screenshot, and it used to sit in the table as a second,
   * blocked copy of a transaction that was already there. Folded into its
   * twin when the amount, direction and a matching party say it is the same
   * transfer; kept, for a person to date, when nothing matches.
   */
  const dated = merged.filter((r) => r.txnDate);
  const samePart = (a: ReviewRow, b: ReviewRow) =>
    (a.reference !== null && a.reference === b.reference) ||
    (Boolean((a.counterpartyAccount ?? '').replace(/\D/g, '')) &&
      (a.counterpartyAccount ?? '').replace(/\D/g, '') === (b.counterpartyAccount ?? '').replace(/\D/g, '')) ||
    (Boolean(slug(a.counterpartyName)) && slug(a.counterpartyName) === slug(b.counterpartyName));
  const kept: ReviewRow[] = [];
  for (const r of merged) {
    if (!r.txnDate && r.amountMinor !== null) {
      const twin = dated.find((d) => d.direction === r.direction && d.amountMinor === r.amountMinor && samePart(d, r));
      if (twin) {
        twin.images = [...new Set([...twin.images, ...r.images])].sort((a, b) => a - b);
        continue;
      }
    }
    kept.push(r);
  }
  return kept;
}

/**
 * A time as a person typed it: "9:03" → "09:03", "16:29:12" as it is.
 * null when empty; undefined when it is not a time at all — the commit route
 * accepts only HH:MM or HH:MM:SS, and "9:03" used to fail there with a message
 * about row data nobody could connect to what they had typed.
 */
export function normaliseTime(text: string | null | undefined): string | null | undefined {
  if (text === null || text === undefined || !text.trim()) return null;
  const m = text.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return undefined;
  const [, h, mi, s] = m;
  if (Number(h) > 23 || Number(mi) > 59 || (s !== undefined && Number(s) > 59)) return undefined;
  return `${h!.padStart(2, '0')}:${mi}${s !== undefined ? `:${s}` : ''}`;
}
