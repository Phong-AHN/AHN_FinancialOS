import type { ISODate } from '@/lib/dates';

/**
 * The rules that stand between a click and money leaving - Spec section 7.
 *
 * Pure and dateless on purpose: every one of these can be tested exhaustively
 * without a network, a database or a dollar. The send path has no sandbox to
 * rehearse in (see migration 0036), so the parts that CAN be proven offline
 * have to be.
 */

/**
 * The largest single payment this system will send without a person removing
 * this limit deliberately.
 *
 * Not a guess at AHN's payroll: a guard against the failure that actually
 * happens, which is a units error. `toMinor` on an already-minor figure turns
 * $4,800 into $480,000, and the system would send it with total confidence.
 * A ceiling is the only thing that catches an error of scale, because every
 * other check passes: the payee is real, the currency is right, the arithmetic
 * is consistent.
 */
export const MAX_PAYMENT_USD_MINOR = 2_000_000; // $20,000
export const MAX_RUN_USD_MINOR = 20_000_000; // $200,000

export interface PayableLine {
  personId: string | null;
  payeeName: string;
  payeeEmail: string;
  payeeCountry: string;
  amountMinor: number;
  currency: string;
}

export interface Refusal {
  line: string;
  reason: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const COUNTRY = /^[A-Z]{2}$/;

/**
 * Everything wrong with a run, all at once.
 *
 * Returns every problem rather than the first: somebody fixing a payroll run
 * should see the whole list, not discover a new fault on each attempt.
 */
export function refusalsFor(
  lines: PayableLine[],
  opts: { maxPayment?: number; maxRun?: number } = {},
): Refusal[] {
  const maxPayment = opts.maxPayment ?? MAX_PAYMENT_USD_MINOR;
  const maxRun = opts.maxRun ?? MAX_RUN_USD_MINOR;
  const out: Refusal[] = [];

  if (lines.length === 0) {
    return [{ line: '—', reason: 'There is nobody to pay in this run.' }];
  }

  const seen = new Map<string, number>();

  for (const line of lines) {
    const who = line.payeeName || line.payeeEmail || 'unnamed';

    if (!Number.isInteger(line.amountMinor) || line.amountMinor <= 0) {
      out.push({ line: who, reason: 'The amount is not a positive whole number of minor units.' });
    } else if (line.amountMinor > maxPayment) {
      out.push({
        line: who,
        reason:
          `${(line.amountMinor / 100).toFixed(2)} ${line.currency} is above the ` +
          `${(maxPayment / 100).toFixed(2)} single-payment ceiling. If that is genuinely the ` +
          'amount, raise the ceiling deliberately rather than working around it.',
      });
    }

    if (!EMAIL.test(line.payeeEmail)) {
      out.push({ line: who, reason: `"${line.payeeEmail}" is not an email address Veem can pay.` });
    }
    if (!COUNTRY.test(line.payeeCountry)) {
      out.push({
        line: who,
        reason: `"${line.payeeCountry}" is not a two-letter country code.`,
      });
    }
    if (line.payeeName.trim() === '') {
      out.push({ line: who, reason: 'The payee has no name.' });
    }

    // The same person twice in one run is a duplicate, not a bonus.
    const key = line.payeeEmail.trim().toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  for (const [email, count] of seen) {
    if (count > 1) {
      out.push({
        line: email,
        reason: `Appears ${count} times in one run. Paying the same person twice is a duplicate, not a bonus.`,
      });
    }
  }

  const total = lines.reduce((sum, l) => sum + (l.amountMinor > 0 ? l.amountMinor : 0), 0);
  if (total > maxRun) {
    out.push({
      line: 'the whole run',
      reason:
        `${(total / 100).toFixed(2)} is above the ${(maxRun / 100).toFixed(2)} ceiling for one ` +
        'run. Split it, or raise the ceiling deliberately.',
    });
  }

  // Mixed currencies in one run are not wrong, but they mean the run total is
  // not a number: adding dong to dollars produces something nobody can approve.
  const currencies = new Set(lines.map((l) => l.currency.toUpperCase()));
  if (currencies.size > 1) {
    out.push({
      line: 'the whole run',
      reason: `Mixes ${[...currencies].join(' and ')}. One run, one currency — a total across two is not a figure anybody can approve.`,
    });
  }

  return out;
}

export function runTotal(lines: PayableLine[]): number {
  return lines.reduce((sum, l) => sum + l.amountMinor, 0);
}

/**
 * May this run be sent right now?
 *
 * Deliberately separate from `refusalsFor`: one asks whether the LINES are
 * sane, this asks whether the RUN is in a state that permits sending. A valid
 * set of lines in a draft run must still not go anywhere.
 */
export function sendRefusal(run: {
  status: string;
  approved_by: string | null;
  created_by: string | null;
  approved_total_minor: number | null;
}, currentTotalMinor: number): string | null {
  if (run.status === 'sent') return 'This run has already been sent.';
  if (run.status === 'sending') return 'This run is already being sent.';
  if (run.status === 'cancelled') return 'This run was cancelled.';
  if (run.status !== 'approved') return 'This run has not been approved yet.';
  if (!run.approved_by) return 'This run has no approver recorded.';
  if (run.approved_by === run.created_by) {
    return 'The approver is the same person who prepared it.';
  }

  /*
   * The total must still be what was signed off.
   *
   * Approving $40,000 and sending $60,000 because a line changed in between is
   * the whole reason approval exists. The frozen total is checked against the
   * live one at the last possible moment.
   */
  if (run.approved_total_minor !== null && run.approved_total_minor !== currentTotalMinor) {
    return (
      `This run was approved at ${(run.approved_total_minor / 100).toFixed(2)} but now totals ` +
      `${(currentTotalMinor / 100).toFixed(2)}. Have it approved again.`
    );
  }
  return null;
}

/** For a confirmation line: "12 people, $38,400.00, for 1–31 Aug". */
export function describeRun(
  lines: PayableLine[],
  period: { start: ISODate; end: ISODate },
): string {
  const total = runTotal(lines);
  const currency = lines[0]?.currency ?? 'USD';
  return `${lines.length} ${lines.length === 1 ? 'person' : 'people'}, ${(total / 100).toFixed(2)} ${currency}, for ${period.start} to ${period.end}`;
}
