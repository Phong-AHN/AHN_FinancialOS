import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireOwner } from '@/lib/auth';
import { loadProjectOptions } from '@/lib/data';
import { PersonLogin, type LoginOption } from '@/components/PersonLogin';
import { hourlyCostOf, type Person } from '@/lib/calc/labour';
import { formatMoney } from '@/lib/money';
import { formatDayLabel } from '@/lib/dates';
import { TimeTracker } from '@/components/TimeTracker';
import {
  Badge,
  Callout,
  Card,
  EmptyState,
  FormulaNote,
  PageHeader,
  SectionHeader,
  StatTile,
} from '@/components/ui';
import type { PersonRow, TimeEntryWithContext } from '@/lib/types';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

const RECENT_DAYS = 60;

/**
 * People, rates and logged time - Spec section 13.
 *
 * Owner-only, and not merely hidden in the markup: `people` and `time_entries`
 * are restricted by RLS (migration 0013), because a rate is compensation. A
 * viewer able to read hours and costs could divide one by the other and recover
 * a salary the payroll policy exists to keep private.
 */
export default async function PeoplePage() {
  const supabase = createSupabaseServerClient();

  const [, peopleRes, entriesRes, projects, loginsRes] = await Promise.all([
    requireOwner(),
    supabase.from('people').select('*').order('name'),
    supabase
      .from('time_entries')
      .select('*, person:people(id,name,kind), project:projects(id,name,kind)')
      .order('work_date', { ascending: false })
      .limit(100),
    loadProjectOptions(supabase),
    // Every login, so a person can be attached to one. RLS already limits
    // this to readers who may manage people.
    supabase.from('users').select('id,email').order('email'),
  ]);

  const people = (peopleRes.data ?? []) as PersonRow[];

  /*
   * Which logins are already spoken for.
   *
   * Migration 0030 makes one login one person, so offering a taken one would
   * produce a constraint violation where an explanation belongs. The picker
   * disables them and says who has them.
   */
  const takenBy = new Map<string, string>();
  for (const person of people) {
    if (person.user_id) takenBy.set(person.user_id, person.name);
  }
  const logins: LoginOption[] = ((loginsRes.data ?? []) as Array<{ id: string; email: string }>).map(
    (u) => ({ id: u.id, email: u.email, takenBy: takenBy.get(u.id) ?? null }),
  );
  const emailOf = (userId: string | null) =>
    userId === null ? null : (logins.find((l) => l.id === userId)?.email ?? 'a deleted login');
  const linkedCount = people.filter((person) => person.user_id).length;
  const entries = (entriesRes.data ?? []) as TimeEntryWithContext[];

  const cutoff = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
  const recent = entries.filter((e) => e.work_date >= cutoff);
  const recentHours = recent.reduce((s, e) => s + Number(e.hours), 0);

  const rateById = new Map(people.map((p) => [p.id, hourlyCostOf(p as Person)]));
  const recentCost = recent.reduce((s, e) => {
    const rate = rateById.get(e.person_id);
    return rate === null || rate === undefined ? s : s + rate * Number(e.hours);
  }, 0);
  const unpricedPeople = people.filter((p) => hourlyCostOf(p as Person) === null);

  return (
    <>
      <PageHeader
        title="People & time"
        subtitle="What the work costs, and which projects consumed it."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="People"
          value={String(people.filter((p) => p.is_active).length)}
          hint={`${people.filter((p) => p.kind === 'contractor').length} contractor(s)`}
        />
        <StatTile
          label={`Hours, last ${RECENT_DAYS} days`}
          value={String(Math.round(recentHours * 10) / 10)}
          hint={`${recent.length} entr${recent.length === 1 ? 'y' : 'ies'}`}
        />
        <StatTile
          label="Cost of that time"
          value={formatMoney(Math.round(recentCost))}
          hint="At each person's loaded hourly cost"
          tone="outflow"
        />
        <StatTile
          label="People with no rate"
          value={String(unpricedPeople.length)}
          hint={
            unpricedPeople.length
              ? 'Their hours are counted but cost nothing'
              : 'Every hour logged can be costed'
          }
          tone={unpricedPeople.length ? 'warn' : 'neutral'}
        />
      </div>

      <FormulaNote>
        A salaried person&rsquo;s hour is their loaded annual cost divided by the hours they are
        actually available — not by a flat 2,080, which would price every hour as though nobody
        ever took leave and make each one about a tenth too cheap.
      </FormulaNote>

      <div className="mt-6">
        <Callout tone="neutral" title="This does not add a new cost">
          Payroll has already left the bank and is counted once in the company P&amp;L. Logging
          time does not spend anything again — it decides which projects that money was spent
          on. A project only ever pays twice if a payroll transaction is also attributed to it
          directly, and the project page says so when that happens.
        </Callout>
      </div>

      <section className="mt-7">
        <SectionHeader title="Record" />
        <TimeTracker
          people={people
            .filter((p) => p.is_active)
            .map((p) => ({ id: p.id, name: p.name, kind: p.kind }))}
          projects={projects.map((p) => ({ id: p.id, name: p.name, kind: p.kind }))}
        />
      </section>

      <section className="mt-7">
        <SectionHeader title="Everyone" subtitle="Rates are visible to the owner only" />
        <Card padded={false}>
          {people.length === 0 ? (
            <EmptyState
              title="Nobody added yet"
              body="Add the employees and contractors who work on projects, with what an hour of their time costs. Until then every project margin is missing the cost of the people who did the work."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-[var(--line)] text-left">
                    <Th>Name</Th>
                    <Th>Kind</Th>
                    <Th>Basis</Th>
                    <Th className="text-right">Cost per hour</Th>
                    <Th className="text-right">Basis figure</Th>
                    <Th>Logs in as</Th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((p) => {
                    const hourly = hourlyCostOf(p as Person);
                    return (
                      <tr key={p.id} className="border-b border-[var(--line)] last:border-0">
                        <Td>
                          <span className="font-medium">{p.name}</span>
                          {!p.is_active && (
                            <span className="ml-2">
                              <Badge>inactive</Badge>
                            </span>
                          )}
                        </Td>
                        <Td className="muted">{p.kind}</Td>
                        <Td className="muted">{p.basis.replace(/_/g, ' ')}</Td>
                        <Td className="tabular text-right">
                          {hourly === null ? (
                            <span style={{ color: 'var(--warn)' }}>no rate</span>
                          ) : (
                            formatMoney(Math.round(hourly))
                          )}
                        </Td>
                        <Td className="muted tabular text-right">
                          {p.basis === 'salaried'
                            ? `${formatMoney(p.annual_cost_minor ?? 0)} / ${p.annual_hours}h`
                            : formatMoney(p.hourly_cost_minor ?? 0)}
                        </Td>
                        <Td>
                          <PersonLogin
                            personId={p.id}
                            personName={p.name}
                            currentUserId={p.user_id}
                            currentEmail={emailOf(p.user_id)}
                            logins={logins}
                          />
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {people.length > 0 && linkedCount < people.length && (
          <p className="muted mt-3 text-[12.5px]">
            {people.length - linkedCount} of {people.length} have no login attached, so they cannot
            fill in their own hours on <strong>My hours</strong> — somebody has to record their time
            for them. Most contractors will never need one; anyone on staff does.
          </p>
        )}
      </section>

      {entries.length > 0 && (
        <section className="mt-7">
          <SectionHeader
            title="Recent time"
            subtitle={`Last ${entries.length} entries, newest first`}
          />
          <Card padded={false}>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-[var(--line)] text-left">
                    <Th>Date</Th>
                    <Th>Person</Th>
                    <Th>Project</Th>
                    <Th className="text-right">Hours</Th>
                    <Th className="text-right">Cost</Th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => {
                    const rate = rateById.get(e.person_id);
                    return (
                      <tr key={e.id} className="border-b border-[var(--line)] last:border-0">
                        <Td className="muted tabular">{formatDayLabel(e.work_date)}</Td>
                        <Td>{e.person?.name ?? '—'}</Td>
                        <Td>
                          {e.project ? (
                            <Link
                              href={`/projects/${e.project.id}`}
                              className="hover:underline"
                            >
                              {e.project.name}
                            </Link>
                          ) : (
                            '—'
                          )}
                        </Td>
                        <Td className="tabular text-right">{Number(e.hours)}</Td>
                        <Td className="muted tabular text-right">
                          {rate === null || rate === undefined ? (
                            <span className="faint">not costed</span>
                          ) : (
                            formatMoney(Math.round(rate * Number(e.hours)))
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </section>
      )}
    </>
  );
}

function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <th
      className={`faint px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.05em] ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-4 py-2.5 ${className}`}>{children}</td>;
}
