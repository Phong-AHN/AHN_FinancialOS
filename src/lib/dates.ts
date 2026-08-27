/**
 * Date helpers for the calc engine.
 *
 * Every function works on ISO date strings (YYYY-MM-DD) in UTC. Financial
 * period boundaries must not drift with the viewer timezone - a transaction
 * booked on the 1st has to land in that month for everyone looking at the
 * dashboard, whether they are in California or Ho Chi Minh City.
 */

export type ISODate = string; // YYYY-MM-DD

export function toISODate(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function parseISODate(s: ISODate): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

export function today(now: Date = new Date()): ISODate {
  return toISODate(now);
}

/** First day of the month containing `d`. */
export function monthStart(d: ISODate | Date): ISODate {
  const date = typeof d === 'string' ? parseISODate(d) : d;
  return toISODate(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
}

/** Last day of the month containing `d`. */
export function monthEnd(d: ISODate | Date): ISODate {
  const date = typeof d === 'string' ? parseISODate(d) : d;
  return toISODate(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)));
}

export function addMonths(d: ISODate, months: number): ISODate {
  const date = parseISODate(d);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  // Clamp the day so 2026-01-31 minus 1 month is 2025-12-31, not 2026-03-03.
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return toISODate(target);
}

export function addDays(d: ISODate, days: number): ISODate {
  const date = parseISODate(d);
  date.setUTCDate(date.getUTCDate() + days);
  return toISODate(date);
}

export function daysBetween(from: ISODate, to: ISODate): number {
  const ms = parseISODate(to).getTime() - parseISODate(from).getTime();
  return Math.round(ms / 86_400_000);
}

export function daysInMonth(d: ISODate): number {
  return parseISODate(monthEnd(d)).getUTCDate();
}

/** Day of the month, 1-based. */
export function dayOfMonth(d: ISODate): number {
  return parseISODate(d).getUTCDate();
}

export interface DateRange {
  from: ISODate;
  to: ISODate;
}

/**
 * The last N COMPLETE calendar months before the month containing `asOf`.
 *
 * Burn rate has to exclude the current partial month: on the 3rd, this month
 * has only three days of spend in it, and averaging that in would understate
 * burn and overstate runway. Spec section 9 calls for the honest number.
 */
export function lastCompleteMonths(asOf: ISODate, n: number): DateRange {
  const currentStart = monthStart(asOf);
  const to = addDays(currentStart, -1);
  const from = monthStart(addMonths(currentStart, -n));
  return { from, to };
}

export function currentMonthRange(asOf: ISODate): DateRange {
  return { from: monthStart(asOf), to: monthEnd(asOf) };
}

/** Trailing window ending on `asOf` inclusive, e.g. last 90 days. */
export function trailingDays(asOf: ISODate, days: number): DateRange {
  return { from: addDays(asOf, -(days - 1)), to: asOf };
}

/**
 * How many whole months a range spans. Used as the denominator for burn, so it
 * must count months, not days/30.
 */
export function monthsInRange(range: DateRange): number {
  const a = parseISODate(range.from);
  const b = parseISODate(range.to);
  return (
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + 1
  );
}

/** "Aug 2026" */
export function formatMonthLabel(d: ISODate): string {
  return parseISODate(d).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "Aug 26" */
export function formatDayLabel(d: ISODate): string {
  return parseISODate(d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const seconds = Math.round((now.getTime() - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Normalise the date shapes that turn up in CSV exports into an ISO date.
 * Ambiguous "03/04/2026" is read as MM/DD/YYYY unless `dayFirst` is set -
 * VN bank statements are usually DD/MM/YYYY, so the import UI exposes it.
 */
export function parseFlexibleDate(
  raw: string | null | undefined,
  opts: { dayFirst?: boolean } = {},
): ISODate | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const slash = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    let year = Number(slash[3]);
    if (year < 100) year += 2000;
    let month: number;
    let day: number;
    if (opts.dayFirst) {
      day = a;
      month = b;
    } else if (a > 12 && b <= 12) {
      day = a;
      month = b; // Unambiguously day-first regardless of the flag.
    } else {
      month = a;
      day = b;
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return toISODate(parsed);
  return null;
}
