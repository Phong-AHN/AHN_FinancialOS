/**
 * Spreading shared software cost across projects - Spec section 12.
 *
 * Section 12 asks for project profitability including allocated costs. Labour
 * arrived with decision 91; software is the other half, and it is the half that
 * needs a decision rather than an algorithm: a ClickUp subscription is not
 * *for* any one project, so any number put against a project is the result of a
 * rule somebody chose.
 *
 * THE BASIS IS LOGGED HOURS, and it is the only one the system can defend.
 *
 *   - **Hours** is a real cost driver and the standard one for professional
 *     services: the projects people spend time on are the projects consuming
 *     the tools. It is also the only basis backed by data this system actually
 *     holds.
 *   - **Headcount** would need people assigned to projects, which nothing
 *     records.
 *   - **An equal split** is the tempting one and the worst. It would charge a
 *     project nobody touched the same as one that ran for a month, and it would
 *     do it with a confident number.
 *   - **Revenue share** makes a profitable project look less profitable purely
 *     because it earned more, which inverts the thing the page exists to show.
 *
 * WHEN NOBODY HAS LOGGED HOURS, NOTHING IS ALLOCATED. Not an equal split, not
 * zero-with-a-shrug: the pool is reported as unallocated with the reason
 * attached, exactly as `/projects` already reports labour it cannot see.
 */

export type AllocationBasis = 'logged_hours';

export interface AllocationResult {
  basis: AllocationBasis;
  /** Shared cost available to spread. */
  poolUsdMinor: number;
  /** What actually landed on projects. Equals the pool, or zero. */
  allocatedUsdMinor: number;
  /** The pool minus what was allocated. Non-zero only when nothing could be. */
  unallocatedUsdMinor: number;
  byProject: Map<string, number>;
  /** Null when the allocation ran. Set when it deliberately did not. */
  reason: string | null;
}

/**
 * Split an integer pool across projects in proportion to hours.
 *
 * LARGEST REMAINDER, not rounding each share independently. Three projects
 * splitting $100.00 by equal hours get 3333, 3333, 3334 — not 3333 three times,
 * which loses a cent, and not 3334 three times, which invents two. The
 * allocated total must equal the pool exactly or the page stops reconciling,
 * and a project P&L that is off by a cent is one somebody stops trusting.
 */
export function allocateByHours(
  poolUsdMinor: number,
  hoursByProject: ReadonlyMap<string, number>,
): AllocationResult {
  const empty = (reason: string | null): AllocationResult => ({
    basis: 'logged_hours',
    poolUsdMinor,
    allocatedUsdMinor: 0,
    unallocatedUsdMinor: poolUsdMinor,
    byProject: new Map(),
    reason,
  });

  if (poolUsdMinor <= 0) return empty(null);

  const entries = [...hoursByProject.entries()].filter(([, hours]) => hours > 0);
  const totalHours = entries.reduce((sum, [, hours]) => sum + hours, 0);

  if (entries.length === 0 || totalHours <= 0) {
    return empty(
      'Nobody has logged hours in this period, so there is no basis to spread shared software cost across. It is reported as unallocated rather than split evenly, which would charge a project nobody touched.',
    );
  }

  // Floor each share, then hand out the remaining cents to the largest
  // fractional parts. Ties break toward the project with more hours, so the
  // result does not depend on Map iteration order.
  const shares = entries.map(([projectId, hours]) => {
    const exact = (poolUsdMinor * hours) / totalHours;
    const floor = Math.floor(exact);
    return { projectId, hours, floor, remainder: exact - floor };
  });

  let distributed = shares.reduce((sum, s) => sum + s.floor, 0);
  const leftover = poolUsdMinor - distributed;

  const order = [...shares].sort(
    (a, b) => b.remainder - a.remainder || b.hours - a.hours || a.projectId.localeCompare(b.projectId),
  );
  for (let i = 0; i < leftover; i++) {
    order[i % order.length]!.floor += 1;
    distributed += 1;
  }

  const byProject = new Map<string, number>();
  for (const s of shares) byProject.set(s.projectId, s.floor);

  return {
    basis: 'logged_hours',
    poolUsdMinor,
    allocatedUsdMinor: distributed,
    unallocatedUsdMinor: poolUsdMinor - distributed,
    byProject,
    reason: null,
  };
}

/** For a caption: "by share of logged hours". */
export function describeBasis(basis: AllocationBasis): string {
  return basis === 'logged_hours' ? 'by share of logged hours' : basis;
}
