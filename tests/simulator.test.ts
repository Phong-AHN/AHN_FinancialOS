import { describe, expect, it } from 'vitest';
import {
  buildScenarios,
  computeBaseline,
  projectGrowth,
  requiredRevenueForMargin,
  scenarioReliability,
  type MonthlyActual,
} from '@/lib/calc/simulator';

const month = (m: string, inflow: number, outflow: number): MonthlyActual => ({
  month: m,
  inflowUsdMinor: inflow,
  outflowUsdMinor: outflow,
});

describe('computeBaseline', () => {
  it('averages the complete months it was given', () => {
    const baseline = computeBaseline([
      month('2026-03-01', 1_000_000, 800_000),
      month('2026-04-01', 1_200_000, 900_000),
      month('2026-05-01', 1_400_000, 1_000_000),
    ]);

    expect(baseline.revenueUsdMinor).toBe(1_200_000);
    expect(baseline.expenseUsdMinor).toBe(900_000);
    expect(baseline.monthsSampled).toBe(3);
    expect(baseline.lastMonth).toBe('2026-05-01');
  });

  it('reads month-over-month growth from the actual months', () => {
    const baseline = computeBaseline([
      month('2026-03-01', 1_000_000, 0),
      month('2026-04-01', 1_100_000, 0),
      month('2026-05-01', 1_320_000, 0),
    ]);
    expect(baseline.observedGrowth).toHaveLength(2);
    expect(baseline.observedGrowth[0]).toBeCloseTo(0.1, 10);
    expect(baseline.observedGrowth[1]).toBeCloseTo(0.2, 10);
  });

  it('skips growth from a month with no revenue instead of calling it infinite', () => {
    // The change from zero is undefined, not infinite. Recording it as infinite
    // would poison every scenario preset built from these numbers.
    const baseline = computeBaseline([
      month('2026-03-01', 0, 500_000),
      month('2026-04-01', 900_000, 500_000),
      month('2026-05-01', 990_000, 500_000),
    ]);
    expect(baseline.observedGrowth).toHaveLength(1);
    expect(baseline.observedGrowth[0]).toBeCloseTo(0.1, 10);
  });

  it('reports how much a typical month varies from the average', () => {
    // A steady business and a lumpy one can share an average while meaning
    // completely different things for a plan compounded off it.
    const steady = computeBaseline([
      month('2026-03-01', 1_000_000, 0),
      month('2026-04-01', 1_010_000, 0),
      month('2026-05-01', 990_000, 0),
    ]);
    const lumpy = computeBaseline([
      month('2026-03-01', 100_000, 0),
      month('2026-04-01', 2_800_000, 0),
      month('2026-05-01', 100_000, 0),
    ]);

    expect(steady.revenueVolatility!).toBeLessThan(0.05);
    expect(lumpy.revenueVolatility!).toBeGreaterThan(0.9);
  });

  it('handles having no history at all without dividing by zero', () => {
    const baseline = computeBaseline([]);
    expect(baseline.revenueUsdMinor).toBe(0);
    expect(baseline.revenueVolatility).toBeNull();
    expect(baseline.lastMonth).toBeNull();
  });
});

describe('projectGrowth', () => {
  const baseline = computeBaseline([
    month('2026-03-01', 1_000_000, 800_000),
    month('2026-04-01', 1_000_000, 800_000),
  ]);

  it('compounds rather than adding', () => {
    // +10% for three months is x1.331, not x1.30. Getting this wrong understates
    // the target by more every month.
    const p = projectGrowth({
      baseline,
      revenueGrowthRate: 0.1,
      expenseGrowthRate: 0,
      months: 3,
    });
    expect(p.months[2]!.revenueTargetUsdMinor).toBe(Math.round(1_000_000 * 1.1 ** 3));
    expect(p.finalMultiple).toBeCloseTo(1.331, 10);
  });

  it('states the multiple the rate implies over the horizon', () => {
    // +15% a month is not +180% a year. Whoever picks the rate should see this.
    const p = projectGrowth({
      baseline,
      revenueGrowthRate: 0.15,
      expenseGrowthRate: 0,
      months: 12,
    });
    expect(p.finalMultiple).toBeCloseTo(5.35, 2);
  });

  it('grows expenses too when told to', () => {
    const p = projectGrowth({
      baseline,
      revenueGrowthRate: 0.1,
      expenseGrowthRate: 0.05,
      months: 6,
    });
    expect(p.months[5]!.expenseForecastUsdMinor).toBe(Math.round(800_000 * 1.05 ** 6));
  });

  it('names the month the plan first turns a profit', () => {
    const losing = computeBaseline([month('2026-05-01', 500_000, 1_000_000)]);
    const p = projectGrowth({
      baseline: losing,
      revenueGrowthRate: 0.5,
      expenseGrowthRate: 0,
      months: 6,
    });
    // 500k x 1.5^n first clears 1,000k at n = 2 (1,125k).
    expect(p.breakEvenMonth).toBe('2026-07-01');
  });

  it('reports no break-even when the plan never reaches one', () => {
    const losing = computeBaseline([month('2026-05-01', 100_000, 1_000_000)]);
    const p = projectGrowth({
      baseline: losing,
      revenueGrowthRate: 0.01,
      expenseGrowthRate: 0.02,
      months: 12,
    });
    expect(p.breakEvenMonth).toBeNull();
    expect(p.totalProfitUsdMinor).toBeLessThan(0);
  });

  it('handles a decline without flipping any signs', () => {
    const p = projectGrowth({
      baseline,
      revenueGrowthRate: -0.1,
      expenseGrowthRate: 0,
      months: 3,
    });
    expect(p.months[2]!.revenueTargetUsdMinor).toBe(Math.round(1_000_000 * 0.9 ** 3));
    expect(p.finalMultiple).toBeLessThan(1);
  });

  it('returns nothing for a zero-month horizon rather than one stray row', () => {
    const p = projectGrowth({ baseline, revenueGrowthRate: 0.1, expenseGrowthRate: 0, months: 0 });
    expect(p.months).toHaveLength(0);
    expect(p.finalMultiple).toBe(1);
  });
});

describe('requiredRevenueForMargin', () => {
  it('solves revenue = expense / (1 - margin)', () => {
    // A 20% margin on 800k of cost needs 1,000k of revenue, leaving 200k.
    const r = requiredRevenueForMargin(0.2, 800_000, 900_000, 6);
    expect(r.requiredRevenueUsdMinor).toBe(1_000_000);
    expect(r.upliftUsdMinor).toBe(100_000);
  });

  it('refuses a margin of 100% or more instead of returning a number', () => {
    // At exactly 1 the equation divides by zero; above it the sign flips and
    // hands back a NEGATIVE revenue target that renders as a plausible figure.
    for (const margin of [1, 1.5]) {
      const r = requiredRevenueForMargin(margin, 800_000, 900_000, 6);
      expect(r.requiredRevenueUsdMinor, `margin ${margin}`).toBeNull();
      expect(r.impossibleReason, `margin ${margin}`).toBeTruthy();
    }
  });

  it('refuses to measure a margin against no spending', () => {
    const r = requiredRevenueForMargin(0.2, 0, 900_000, 6);
    expect(r.requiredRevenueUsdMinor).toBeNull();
    expect(r.impossibleReason).toContain('No forecast expense');
  });

  it('works out the monthly growth that reaches the target', () => {
    const r = requiredRevenueForMargin(0.2, 800_000, 500_000, 12);
    expect(r.impliedMonthlyGrowth).toBeCloseTo(Math.pow(1_000_000 / 500_000, 1 / 12) - 1, 10);
  });

  it('says nothing about growth from a baseline of zero', () => {
    // Growth from nothing is undefined, not infinite.
    const r = requiredRevenueForMargin(0.2, 800_000, 0, 12);
    expect(r.requiredRevenueUsdMinor).toBe(1_000_000);
    expect(r.impliedMonthlyGrowth).toBeNull();
  });

  it('handles a negative margin target as a tolerated loss', () => {
    // "I will accept losing 10%" is a real plan, and it needs less revenue than
    // breaking even, not more.
    const r = requiredRevenueForMargin(-0.1, 1_100_000, 0, 6);
    expect(r.requiredRevenueUsdMinor).toBe(1_000_000);
  });
});

describe('buildScenarios', () => {
  it('derives the three cases from the months the company actually had', () => {
    // Growth observed: -10%, +20%, +10%. Sorted: [-0.1, 0.1, 0.2].
    // Quartiles: p25 = 0.0, median = 0.1, p75 = 0.15.
    const baseline = computeBaseline([
      month('2026-01-01', 1_000_000, 0),
      month('2026-02-01', 900_000, 0), // -10%
      month('2026-03-01', 1_080_000, 0), // +20%
      month('2026-04-01', 1_188_000, 0), // +10%
    ]);
    const [conservative, base, aggressive] = buildScenarios(baseline);

    expect(conservative!.revenueGrowthRate).toBeCloseTo(0, 10);
    expect(base!.revenueGrowthRate).toBeCloseTo(0.1, 10);
    expect(aggressive!.revenueGrowthRate).toBeCloseTo(0.15, 10);
    // Every preset explains where its number came from.
    for (const s of [conservative, base, aggressive]) {
      expect(s!.derivation.length).toBeGreaterThan(10);
    }
  });

  it('does not let one freak month define the conservative or aggressive case', () => {
    // Found by reading the live output rather than by a failing test: against
    // real data the min/max version produced a "conservative" case of -100%
    // (one month where revenue stopped) and an "aggressive" case of +1278%
    // (one month with a large contract). Compounded over a year the second is
    // a number with no meaning, and the first says revenue is zero forever.
    //
    // Quartiles are robust to both, which is why the base case already used a
    // median. The outer cases were the inconsistency.
    const baseline = computeBaseline([
      month('2026-01-01', 1_000_000, 0),
      month('2026-02-01', 1_050_000, 0), // +5%
      month('2026-03-01', 1_102_500, 0), // +5%
      month('2026-04-01', 1_157_625, 0), // +5%
      month('2026-05-01', 0, 0), // -100%, revenue stopped for a month
    ]);
    const [conservative, , aggressive] = buildScenarios(baseline);

    expect(conservative!.revenueGrowthRate).toBeGreaterThan(-1);
    expect(aggressive!.revenueGrowthRate).toBeLessThan(0.5);
  });

  it('never calls a growing month the conservative case', () => {
    // If even the worst month grew, the pessimistic case is flat — not "we
    // will keep growing at our slowest rate", which is still optimism.
    const baseline = computeBaseline([
      month('2026-01-01', 1_000_000, 0),
      month('2026-02-01', 1_050_000, 0),
      month('2026-03-01', 1_200_000, 0),
    ]);
    expect(buildScenarios(baseline)[0]!.revenueGrowthRate).toBe(0);
  });

  it('uses the median so one exceptional month cannot set the plan', () => {
    const baseline = computeBaseline([
      month('2026-01-01', 1_000_000, 0),
      month('2026-02-01', 1_050_000, 0), // +5%
      month('2026-03-01', 1_102_500, 0), // +5%
      month('2026-04-01', 3_307_500, 0), // +200%, one huge contract
    ]);
    const [, base, aggressive] = buildScenarios(baseline);
    if (!base) throw new Error('no base scenario');
    expect(base.revenueGrowthRate).toBeCloseTo(0.05, 10);
    // The +200% month pulls the upper quartile without owning it outright.
    expect(aggressive!.revenueGrowthRate).toBeLessThan(1.2);
  });

  it('collapses to flat when there is not enough history to read a range', () => {
    const baseline = computeBaseline([month('2026-04-01', 1_000_000, 0)]);
    const scenarios = buildScenarios(baseline);
    expect(scenarios.every((s) => s.revenueGrowthRate === 0)).toBe(true);
    expect(scenarios[1]!.derivation).toContain('complete month');
  });
});

describe('scenarioReliability', () => {
  const steadyMonths = Array.from({ length: 9 }, (_, i) =>
    month(`2026-${String(i + 1).padStart(2, '0')}-01`, Math.round(1_000_000 * 1.05 ** i), 0),
  );

  it('trusts presets built on enough steady months', () => {
    expect(scenarioReliability(computeBaseline(steadyMonths)).reliable).toBe(true);
  });

  it('does not trust quartiles interpolated between a few points', () => {
    // The case found live: three growth observations produced an "aggressive"
    // scenario of +652% from one large contract. Quartiles are robust given
    // enough points; three is not enough, and no amount of extra arithmetic
    // changes that — saying so is the fix.
    const r = scenarioReliability(computeBaseline(steadyMonths.slice(0, 4)));
    expect(r.reliable).toBe(false);
    expect(r.reason).toContain('months of growth');
  });

  it('does not trust presets when the middle half of months disagree wildly', () => {
    const lumpy = computeBaseline([
      month('2026-01-01', 1_000_000, 0),
      month('2026-02-01', 200_000, 0),
      month('2026-03-01', 3_000_000, 0),
      month('2026-04-01', 400_000, 0),
      month('2026-05-01', 2_500_000, 0),
      month('2026-06-01', 300_000, 0),
      month('2026-07-01', 2_000_000, 0),
    ]);
    const r = scenarioReliability(lumpy);
    expect(r.reliable).toBe(false);
    expect(r.reason).toContain('points of growth');
  });

  it('says so plainly when there is barely any history', () => {
    const r = scenarioReliability(computeBaseline([month('2026-04-01', 1_000_000, 0)]));
    expect(r.reliable).toBe(false);
    expect(r.reason).toBeTruthy();
  });
});
