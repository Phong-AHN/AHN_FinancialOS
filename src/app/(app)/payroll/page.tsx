import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireSession, sessionCan } from '@/lib/auth';
import { PayrollRuns } from '@/components/PayrollRuns';
import { formatMoney } from '@/lib/money';
import { formatDayLabel, formatDateTime } from '@/lib/dates';
import { Badge, Callout, Card, EmptyState, PageHeader, SectionHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Paying people - Spec section 7.
 *
 * THE ONLY PAGE IN THIS SYSTEM THAT CAUSES MONEY TO LEAVE. Everything else
 * reads. It is arranged so the dangerous action is the hard one:
 *
 *   - A run is prepared, then approved by SOMEBODY ELSE, then sent. The
 *     database enforces the second person, not this page.
 *   - "Preview" is what the button does by default. It builds every payload
 *     and calls nothing, because Veem has no sandbox to rehearse in.
 *   - Sending requires typing the word SEND.
 */
export default async function PayrollPage() {
  const supabase = createSupabaseServerClient();
  const [session, runsRes, peopleRes] = await Promise.all([
    requireSession(),
    supabase.from('payroll_runs').select('*').order('created_at', { ascending: false }).limit(20),
    supabase.from('people').select('id,name,email,is_active').eq('is_active', true).order('name'),
  ]);

  const canDisburse = sessionCan(session, 'disburse');
  const runs = (runsRes.data ?? []) as Array<{
    id: string;
    name: string;
    status: string;
    currency: string;
    period_start: string;
    period_end: string;
    approved_total_minor: number | null;
    approved_by: string | null;
    created_by: string | null;
    sent_at: string | null;
    created_at: string;
  }>;
  const people = (peopleRes.data ?? []) as Array<{ id: string; name: string; email: string | null }>;

  const payable = people.filter((p) => p.email);

  return (
    <>
      <PageHeader
        title="Payroll"
        subtitle="Prepare a run, have somebody else approve it, then send. Money leaves from here — nowhere else in this system does."
      />

      {!canDisburse ? (
        <Card>
          <EmptyState
            title="You cannot send payments"
            body="Sending money is restricted to the owner and the CFO, and a run must be approved by somebody other than whoever prepared it. This is enforced by the database, not by this page."
          />
        </Card>
      ) : (
        <>
          <div className="mb-5">
            <Callout tone="warn" title="There is no rehearsal">
              VEEM publishes a sandbox host, but it serves a sign-in page rather than an API — so
              the first real send goes against production money. <strong>Preview every run
              first</strong>: it builds the exact payload for each person and calls nothing.
              Single payments are capped at $20,000 and a whole run at $200,000; those limits
              exist to catch a units error, which is the mistake that actually happens.
            </Callout>
          </div>

          <PayrollRuns people={payable} runs={runs} currentUserId={session.user.id} />

          <section className="mt-7">
            <SectionHeader
              title="Recent runs"
              subtitle={runs.length === 0 ? 'Nothing yet' : `${runs.length} on file`}
            />
            <Card padded={false}>
              {runs.length === 0 ? (
                <EmptyState
                  title="No payroll runs yet"
                  body={
                    payable.length === 0
                      ? 'Add people with an email address on the People & time page first — VEEM pays to an email.'
                      : 'Prepare one above.'
                  }
                />
              ) : (
                <ul className="divide-y divide-[var(--line)]">
                  {runs.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium">
                          {r.name}{' '}
                          <Badge tone={r.status === 'sent' ? 'inflow' : r.status === 'cancelled' ? 'neutral' : 'warn'}>
                            {r.status}
                          </Badge>
                        </p>
                        <p className="muted mt-0.5 text-[12px]">
                          {formatDayLabel(r.period_start)} – {formatDayLabel(r.period_end)}
                          {r.approved_total_minor !== null && (
                            <> · approved at {formatMoney(r.approved_total_minor, r.currency)}</>
                          )}
                        </p>
                        <p className="faint mt-0.5 text-[11px]">
                          Prepared {formatDateTime(r.created_at)}
                          {r.sent_at && <> · sent {formatDateTime(r.sent_at)}</>}
                        </p>
                      </div>
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
