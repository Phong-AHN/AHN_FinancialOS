import { describe, expect, it } from 'vitest';
import {
  HORIZON_DAYS,
  describeRecurrence,
  dueDatesInWindow,
  isTemplate,
  missingInstances,
} from '@/lib/calc/recurring';

describe('dueDatesInWindow', () => {
  it('keeps a monthly commitment on the same day of the month', () => {
    // Rent due on the 1st must keep landing on the 1st. Counting forward from
    // "today" would drift the day every time the job ran.
    const dates = dueDatesInWindow(
      { dueOn: '2026-09-01', recurrence: 'monthly' },
      '2026-09-01',
      { horizonDays: 70 },
    );
    expect(dates).toEqual(['2026-09-01', '2026-10-01', '2026-11-01']);
  });

  it('walks from the template date even when that is long past', () => {
    // A payroll commitment set up in 2024 still falls due on the same day now.
    const dates = dueDatesInWindow(
      { dueOn: '2024-01-15', recurrence: 'monthly' },
      '2026-09-03',
      // 15 Oct is 42 days out, so the window has to reach it.
      { horizonDays: 45 },
    );
    expect(dates).toEqual(['2026-09-15', '2026-10-15']);
  });

  it('never regenerates the past', () => {
    // A template dated before today records something that already happened.
    // Recreating it would invent history and inflate what is owed.
    const dates = dueDatesInWindow(
      { dueOn: '2026-08-01', recurrence: 'monthly' },
      '2026-09-03',
      { horizonDays: 30 },
    );
    expect(dates.every((d) => d >= '2026-09-03')).toBe(true);
  });

  it('clamps a 31st to the last day of a shorter month', () => {
    // The 31st of February is not a date anybody is invoiced on.
    const dates = dueDatesInWindow(
      { dueOn: '2026-12-31', recurrence: 'monthly' },
      '2026-12-31',
      { horizonDays: 70 },
    );
    expect(dates).toEqual(['2026-12-31', '2027-01-31', '2027-02-28']);
  });

  it('steps a quarter and a year', () => {
    expect(
      dueDatesInWindow({ dueOn: '2026-09-10', recurrence: 'quarterly' }, '2026-09-01', {
        horizonDays: 200,
      }),
    ).toEqual(['2026-09-10', '2026-12-10', '2027-03-10']);

    expect(
      dueDatesInWindow({ dueOn: '2026-09-10', recurrence: 'annual' }, '2026-09-01', {
        horizonDays: 400,
      }),
    ).toEqual(['2026-09-10', '2027-09-10']);
  });

  it('stops at the end date', () => {
    const dates = dueDatesInWindow(
      { dueOn: '2026-09-01', recurrence: 'monthly', recursUntil: '2026-10-15' },
      '2026-09-01',
      { horizonDays: HORIZON_DAYS },
    );
    expect(dates).toEqual(['2026-09-01', '2026-10-01']);
  });

  it('generates nothing beyond the horizon', () => {
    // Filling a year of aging buckets with commitments nobody has made yet
    // would make "overdue" meaningless.
    const dates = dueDatesInWindow({ dueOn: '2026-09-01', recurrence: 'monthly' }, '2026-09-01');
    expect(dates.length).toBeLessThanOrEqual(4);
    expect(dates.every((d) => d <= '2026-12-01')).toBe(true);
  });
});

describe('missingInstances', () => {
  it('skips the dates that already exist', () => {
    // The job runs daily. It must not create thirty copies of March's rent.
    const missing = missingInstances(
      { dueOn: '2026-09-01', recurrence: 'monthly' },
      '2026-09-01',
      ['2026-09-01', '2026-10-01'],
      { horizonDays: 70 },
    );
    expect(missing.map((m) => m.dueOn)).toEqual(['2026-11-01']);
  });

  it('is a no-op once everything in the window exists', () => {
    const missing = missingInstances(
      { dueOn: '2026-09-01', recurrence: 'monthly' },
      '2026-09-01',
      ['2026-09-01', '2026-10-01', '2026-11-01'],
      { horizonDays: 70 },
    );
    expect(missing).toEqual([]);
  });
});

describe('isTemplate', () => {
  it('treats a generated instance as not a template', () => {
    // Otherwise each month's row starts generating its own children and the
    // table grows geometrically.
    expect(isTemplate({ recurrence: 'monthly', generated_from_id: 'abc' })).toBe(false);
    expect(isTemplate({ recurrence: 'monthly', generated_from_id: null })).toBe(true);
  });

  it('ignores a voided template', () => {
    expect(isTemplate({ recurrence: 'monthly', status: 'void' })).toBe(false);
  });

  it('ignores a row that repeats without saying how often', () => {
    // `is_recurring` recorded that a thing repeats without a cadence. Inventing
    // a monthly rhythm on its behalf would put money in the forecast that
    // nobody committed to.
    expect(isTemplate({ recurrence: null })).toBe(false);
  });
});

describe('describeRecurrence', () => {
  it('says it plainly', () => {
    expect(describeRecurrence('monthly')).toBe('every month');
    expect(describeRecurrence('quarterly')).toBe('every quarter');
    expect(describeRecurrence('annual')).toBe('every year');
    expect(describeRecurrence(null)).toBe('does not repeat');
  });
});
