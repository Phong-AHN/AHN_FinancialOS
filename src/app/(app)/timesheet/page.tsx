import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth';
import { Timesheet, type TimesheetProject } from '@/components/Timesheet';
import { addDays, formatDayLabel, today } from '@/lib/dates';
import { Callout, Card, EmptyState, PageHeader, SectionHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

/** Matches `may_log_own_time` in migration 0029. */
const SELF_SERVICE_DAYS = 14;

/**
 * My hours - Spec section 13.
 *
 * Time entries could only be written by the owner or CFO, which in practice
 * meant one person typing everybody's timesheet — so nobody's got typed, and
 * every project margin in the app carries a caveat that labour is not counted.
 * Section 12's premise is that a project staffed by three people should not
 * look as profitable as one nobody touched.
 *
 * Everything here is scoped by Postgres rather than by this file: the caller's
 * own `people` row, their own entries, and a projects view that carries names
 * without contract values.
 */
export default async function TimesheetPage() {
  const asOf = today();
  const earliest = addDays(asOf, -SELF_SERVICE_DAYS);

  const supabase = createSupabaseServerClient();
  const [session, personRes, projectsRes] = await Promise.all([
    requireSession(),
    /*
     * Filtered on the caller's own user id in the QUERY, not afterwards.
     *
     * RLS returns an employee exactly one row, which made it tempting to take
     * "the row with a login on it". That is wrong for anybody who can see
     * compensation: an owner gets EVERY person back, and the first one with a
     * login attached is very unlikely to be them. They would have been shown a
     * colleague's hours and logged their own time against that colleague's
     * cost, silently, with RLS permitting all of it.
     */
    supabase.from('people').select('id,name,user_id').limit(50),
    supabase.from('projects_for_time').select('id,name,kind').order('name'),
  ]);

  const people = (personRes.data ?? []) as Array<{ id: string; name: string; user_id: string | null }>;
  const me = people.find((p) => p.user_id === session.user.id) ?? null;

  const projects = ((projectsRes.data ?? []) as TimesheetProject[]) ?? [];

  const entriesRes = me
    ? await supabase
        .from('time_entries')
        .select('id,work_date,hours,notes,project_id')
        .eq('person_id', me.id)
        .gte('work_date', addDays(asOf, -60))
        .order('work_date', { ascending: false })
        .limit(60)
    : { data: [] };

  const entries = (entriesRes.data ?? []) as Array<{
    id: string;
    work_date: string;
    hours: number;
    notes: string | null;
    project_id: string;
  }>;

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'A closed project';
  const loggedThisWindow = entries
    .filter((e) => e.work_date >= earliest)
    .reduce((s, e) => s + Number(e.hours), 0);

  return (
    <>
      <PageHeader
        title="My hours"
        subtitle="Time logged against projects. It is what turns a project's margin from a guess into a number."
      />

      {!me ? (
        <Card>
          <EmptyState
            title="Your login is not linked to a person yet"
            body="Hours are recorded against a person, not a login — a contractor can have one without the other. An owner can link them on the People & time page. Until then there is nothing here to fill in."
          />
        </Card>
      ) : (
        <>
          <Card>
            <SectionHeader
              title="Log time"
              subtitle={`Anything from ${formatDayLabel(earliest)} onwards. Older days have to go through an owner.`}
            />
            <Timesheet
              personId={me.id}
              projects={projects}
              today={asOf}
              earliest={earliest}
            />
          </Card>

          <div className="mt-6">
            <Callout tone="neutral" title="Why this matters more than it looks">
              Every project P&amp;L in this system says the same thing: labour is not counted.
              These rows are the missing half. Until they exist, a project three people worked on
              for a month reads exactly as profitably as one nobody touched.
            </Callout>
          </div>

          <section className="mt-7">
            <SectionHeader
              title="Recently logged"
              subtitle={
                entries.length === 0
                  ? 'Nothing yet'
                  : `${loggedThisWindow.toFixed(1)} hours in the last ${SELF_SERVICE_DAYS} days`
              }
            />
            <Card padded={false}>
              {entries.length === 0 ? (
                <EmptyState title="No hours logged yet" body="The form above is the way in." />
              ) : (
                <ul className="divide-y divide-[var(--line)]">
                  {entries.map((e) => (
                    <li key={e.id} className="flex items-center justify-between gap-4 p-4">
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium">
                          {projectName(e.project_id)}
                        </p>
                        <p className="muted mt-0.5 text-[12px]">
                          {formatDayLabel(e.work_date)}
                          {e.notes && <span className="faint"> · {e.notes}</span>}
                          {e.work_date < earliest && (
                            <span className="faint"> · locked, ask an owner to change it</span>
                          )}
                        </p>
                      </div>
                      <p className="tabular shrink-0 text-[13px] font-medium">
                        {Number(e.hours).toFixed(1)} h
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>
        </>
      )}
    </>
  );
}
