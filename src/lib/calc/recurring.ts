import type { ISODate } from '@/lib/dates';
import { addMonths, daysBetween, parseISODate, toISODate } from '@/lib/dates';

/**
 * When a recurring commitment next falls due - Spec section 18.
 *
 * Pure and dateless: every input is passed in, so the same template produces
 * the same schedule on any machine, in any month, in any timezone.
 */

export type Recurrence = 'monthly' | 'quarterly' | 'annual';

const MONTHS_PER: Record<Recurrence, number> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
};

/**
 * How far ahead commitments are generated.
 *
 * Ninety days covers the quarter a CFO is actually looking at, and matches the
 * longest window the obligations page offers. Generating years ahead would fill
 * the aging buckets with rows nobody has committed to yet and make "overdue"
 * meaningless the moment a template's amount changed.
 */
export const HORIZON_DAYS = 90;

export interface RecurringTemplate {
  dueOn: ISODate;
  recurrence: Recurrence;
  /** Inclusive. Null means it runs until somebody stops it. */
  recursUntil?: ISODate | null;
}

/**
 * The due dates this template should have, between `asOf` and the horizon.
 *
 * WHY IT WALKS FROM THE TEMPLATE'S OWN DATE rather than from today: a rent
 * commitment due on the 1st must keep landing on the 1st. Counting forward from
 * "now" would drift the day of the month every time the job ran, and a
 * commitment that moves around the calendar cannot be reconciled against the
 * payment that settles it.
 *
 * `addMonths` clamps a 31st to the last day of a shorter month, which is what
 * a monthly commitment does in reality — the 31st of February is not a date
 * anybody is invoiced on.
 */
export function dueDatesInWindow(
  template: RecurringTemplate,
  asOf: ISODate,
  opts: { horizonDays?: number } = {},
): ISODate[] {
  const horizonDays = opts.horizonDays ?? HORIZON_DAYS;
  const step = MONTHS_PER[template.recurrence];
  const out: ISODate[] = [];

  // A guard against a template whose date is years in the past: walking one
  // month at a time from 2019 is thousands of iterations to reach the window.
  // Jump most of the way in one step, then walk the remainder.
  const monthsBehind = monthsBetween(template.dueOn, asOf);
  const skip = Math.max(0, Math.floor(monthsBehind / step) - 1) * step;

  let cursor = skip > 0 ? addMonths(template.dueOn, skip) : template.dueOn;

  for (let guard = 0; guard < 500; guard++) {
    const fromNow = daysBetween(asOf, cursor);
    if (fromNow > horizonDays) break;
    if (template.recursUntil && cursor > template.recursUntil) break;

    // Only future-or-today instances. A template dated in the past is a record
    // of something that already happened; regenerating it would invent history.
    if (fromNow >= 0) out.push(cursor);

    cursor = addMonths(cursor, step);
  }

  return out;
}

/** Whole months between two ISO dates, ignoring the day of month. */
function monthsBetween(from: ISODate, to: ISODate): number {
  const a = parseISODate(from);
  const b = parseISODate(to);
  return (
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth())
  );
}

export interface PlannedInstance {
  dueOn: ISODate;
}

/**
 * What is missing, given what already exists.
 *
 * The caller passes the due dates already generated for this template, so the
 * decision "is this one new" is made against real rows rather than against an
 * assumption about how often the job has run.
 */
export function missingInstances(
  template: RecurringTemplate,
  asOf: ISODate,
  existingDueDates: Iterable<ISODate>,
  opts: { horizonDays?: number } = {},
): PlannedInstance[] {
  const have = new Set(existingDueDates);
  return dueDatesInWindow(template, asOf, opts)
    .filter((d) => !have.has(d))
    .map((dueOn) => ({ dueOn }));
}

/** For a label: "every month", "every 3 months", "every year". */
export function describeRecurrence(recurrence: Recurrence | null | undefined): string {
  if (!recurrence) return 'does not repeat';
  return { monthly: 'every month', quarterly: 'every quarter', annual: 'every year' }[recurrence];
}

/** Kept out of the walk above so the intent is visible at the call site. */
export function isTemplate(row: {
  recurrence?: Recurrence | null;
  generated_from_id?: string | null;
  status?: string;
}): boolean {
  // A generated instance is never itself a template — otherwise each month's
  // row would start generating its own children and the table would grow
  // geometrically.
  return Boolean(row.recurrence) && !row.generated_from_id && row.status !== 'void';
}

export { toISODate };
