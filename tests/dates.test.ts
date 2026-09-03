import { describe, expect, it } from 'vitest';
import {
  BUSINESS_TIME_ZONE,
  addDays,
  daysBetween,
  formatDayLabel,
  monthEnd,
  monthStart,
  today,
  toISODate,
} from '@/lib/dates';

/**
 * The two clocks, and why they are different.
 *
 * Stored dates are UTC ISO strings and all arithmetic over them stays in UTC —
 * that is what keeps a transaction booked on the 1st inside that month for a
 * reader in California and a reader in Ho Chi Minh City.
 *
 * "What day is it right now" is a different question, and UTC is the wrong
 * clock for it. AHN operates from Vietnam; Vercel does not.
 */
describe('today', () => {
  it('answers with the date where the business is, not where the server runs', () => {
    // 17:42 UTC on 2 September is 00:42 on 3 September in Vietnam. This exact
    // moment is how the bug was found: a rate fetched then was filed under the
    // 2nd while every clock in the office said the 3rd.
    const instant = new Date('2026-09-02T17:42:29.420Z');

    expect(toISODate(instant), 'UTC really is still on the 2nd').toBe('2026-09-02');
    expect(today(instant, 'Asia/Ho_Chi_Minh')).toBe('2026-09-03');
  });

  it('agrees with UTC for the seventeen hours a day the two clocks share a date', () => {
    const midday = new Date('2026-09-02T05:00:00.000Z'); // noon in Vietnam
    expect(today(midday, 'Asia/Ho_Chi_Minh')).toBe('2026-09-02');
    expect(today(midday, 'UTC')).toBe('2026-09-02');
  });

  it('rolls the month and the year on the business clock, not the server one', () => {
    // 30 September 23:00 UTC is already 1 October in Vietnam. Getting this
    // wrong puts a day in the wrong month at exactly the moment — month end —
    // when somebody is closing the books.
    expect(today(new Date('2026-09-30T23:00:00.000Z'), 'Asia/Ho_Chi_Minh')).toBe('2026-10-01');
    expect(today(new Date('2026-12-31T23:00:00.000Z'), 'Asia/Ho_Chi_Minh')).toBe('2027-01-01');
  });

  it('falls back to UTC rather than throwing on a zone the runtime does not know', () => {
    // A misconfigured environment variable must not take the app down over a
    // date. UTC is the old behaviour, so it is the smallest possible loss.
    expect(today(new Date('2026-09-02T17:42:00.000Z'), 'Mars/Olympus_Mons')).toBe('2026-09-02');
  });

  it('defaults to Vietnam', () => {
    expect(BUSINESS_TIME_ZONE).toBe('Asia/Ho_Chi_Minh');
  });

  it('never returns anything but an ISO date', () => {
    for (const zone of ['Asia/Ho_Chi_Minh', 'UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      expect(today(new Date(), zone), zone).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('stored-date arithmetic stays in UTC', () => {
  // The half that must NOT move with a timezone. These operate on strings that
  // are already dates, where there is no time of day to reinterpret.
  it('keeps month boundaries fixed wherever the reader is', () => {
    expect(monthStart('2026-09-30')).toBe('2026-09-01');
    expect(monthEnd('2026-09-01')).toBe('2026-09-30');
    expect(monthEnd('2028-02-01'), 'leap year').toBe('2028-02-29');
  });

  it('adds days without drifting across a daylight-saving change', () => {
    // Vietnam has no DST, but a reader's browser might; this arithmetic is
    // string-to-string through UTC and cannot be affected either way.
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
    expect(daysBetween('2026-09-01', '2026-09-30')).toBe(29);
  });

  it('labels a stored date as itself, not as the server saw it', () => {
    expect(formatDayLabel('2026-09-03')).toBe('Sep 3');
  });
});
