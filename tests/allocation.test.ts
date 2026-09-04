import { describe, expect, it } from 'vitest';
import { allocateByHours, describeBasis } from '@/lib/calc/allocation';

describe('allocateByHours', () => {
  it('splits in proportion to hours', () => {
    const out = allocateByHours(100_000, new Map([['a', 30], ['b', 10]]));
    expect(out.byProject.get('a')).toBe(75_000);
    expect(out.byProject.get('b')).toBe(25_000);
  });

  it('never loses or invents a cent', () => {
    // Three ways of splitting $100.00 equally: 3333 each loses one, 3334 each
    // invents two. A project P&L off by a cent is one somebody stops trusting.
    const out = allocateByHours(10_000, new Map([['a', 1], ['b', 1], ['c', 1]]));
    const total = [...out.byProject.values()].reduce((s, v) => s + v, 0);
    expect(total).toBe(10_000);
    expect(out.allocatedUsdMinor).toBe(10_000);
    expect(out.unallocatedUsdMinor).toBe(0);
    expect([...out.byProject.values()].sort()).toEqual([3_333, 3_333, 3_334]);
  });

  it('adds back to the pool for awkward ratios too', () => {
    for (const pool of [1, 7, 99, 100_001, 3_333_337]) {
      const out = allocateByHours(pool, new Map([['a', 7], ['b', 11], ['c', 13], ['d', 0.5]]));
      const total = [...out.byProject.values()].reduce((s, v) => s + v, 0);
      expect(total, `pool ${pool}`).toBe(pool);
    }
  });

  it('gives the same answer whatever order the projects arrive in', () => {
    // Otherwise a page refresh could move a cent between two projects.
    const forwards = allocateByHours(10_000, new Map([['a', 1], ['b', 1], ['c', 1]]));
    const backwards = allocateByHours(10_000, new Map([['c', 1], ['b', 1], ['a', 1]]));
    expect([...forwards.byProject].sort()).toEqual([...backwards.byProject].sort());
  });

  it('allocates nothing when nobody logged hours, and says why', () => {
    // The decision this file turns on. An equal split would charge a project
    // nobody touched, with a confident number.
    const out = allocateByHours(50_000, new Map([['a', 0], ['b', 0]]));
    expect(out.byProject.size).toBe(0);
    expect(out.allocatedUsdMinor).toBe(0);
    expect(out.unallocatedUsdMinor).toBe(50_000);
    expect(out.reason).toMatch(/logged hours/);
  });

  it('allocates nothing when there are no projects at all', () => {
    const out = allocateByHours(50_000, new Map());
    expect(out.unallocatedUsdMinor).toBe(50_000);
    expect(out.reason).not.toBeNull();
  });

  it('ignores a project with no hours rather than giving it a share', () => {
    const out = allocateByHours(10_000, new Map([['worked', 10], ['untouched', 0]]));
    expect(out.byProject.get('worked')).toBe(10_000);
    expect(out.byProject.has('untouched')).toBe(false);
  });

  it('has nothing to say about an empty pool', () => {
    // No spend is not a failure, so there is no reason to report.
    const out = allocateByHours(0, new Map([['a', 10]]));
    expect(out.allocatedUsdMinor).toBe(0);
    expect(out.reason).toBeNull();
  });

  it('names its basis for the caption', () => {
    expect(describeBasis('logged_hours')).toBe('by share of logged hours');
  });
});
