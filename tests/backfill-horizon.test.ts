import { describe, expect, it } from 'vitest';
import { addDays, today, trailingDays } from '@/lib/dates';

/**
 * The horizon that stops a first sync from paging the CEO hundreds of times.
 *
 * The engine compares `txn_date` against `trailingDays(asOf, maxAge + 1).from`.
 * These lock the boundary arithmetic, which is the part that is easy to get off
 * by one — and being off by one here means either a day of real money goes
 * unannounced, or a day of history gets announced.
 */
function horizonFor(asOf: string, maxAgeDays: number): string {
  return trailingDays(asOf, maxAgeDays + 1).from;
}

describe('alert backfill horizon', () => {
  const asOf = '2026-08-27';

  it('announces today and the last three days', () => {
    const horizon = horizonFor(asOf, 3);
    for (const offset of [0, -1, -2, -3]) {
      const date = addDays(asOf, offset);
      expect(date >= horizon, `${date} should be announced`).toBe(true);
    }
  });

  it('suppresses anything older', () => {
    const horizon = horizonFor(asOf, 3);
    for (const offset of [-4, -30, -180]) {
      const date = addDays(asOf, offset);
      expect(date >= horizon, `${date} should be suppressed`).toBe(false);
    }
  });

  it('suppresses a six-month backfill entirely', () => {
    // The scenario: connect QuickBooks, it pulls 180 days, and every row is
    // "new" to the engine. Without the horizon that is one burst of hundreds.
    const horizon = horizonFor(asOf, 3);
    const backfill = Array.from({ length: 180 }, (_, i) => addDays(asOf, -(i + 4)));
    expect(backfill.every((d) => d < horizon)).toBe(true);
  });

  it('a horizon of zero still announces today', () => {
    expect(addDays(asOf, 0) >= horizonFor(asOf, 0)).toBe(true);
    expect(addDays(asOf, -1) >= horizonFor(asOf, 0)).toBe(false);
  });

  it('uses a real date, not a relative offset', () => {
    // Guards against comparing an ISO date to something that is not one.
    expect(horizonFor(today(), 3)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
