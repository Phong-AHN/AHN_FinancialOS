import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireSession, sessionCan } from '@/lib/auth';
import { loadCategories, loadObligationBoard, loadProjectOptions } from '@/lib/data';
import { formatMoney } from '@/lib/money';
import { formatDayLabel } from '@/lib/dates';
import { categoryLabel } from '@/lib/categorize';
import { ObligationEditor, SettleButton } from '@/components/ObligationEditor';
import {
  agingBucket,
  type AgingLine,
  type Obligation,
} from '@/lib/calc/obligations';
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
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

/**
 * Receivables and payables - Spec sections 17 and 18.
 *
 * The figure this page exists for is `committedCashUsdMinor`: cash today minus
 * everything owed inside the horizon. A company with $200k in the bank and
 * $180k of payroll due on Friday does not have $200k, and every other cash
 * figure in this system says it does.
 *
 * Receivables are shown, and deliberately left OUT of that headline. A bill is
 * a promise AHN has to keep; an invoice is a promise somebody else made to it.
 * Counting expected receipts in the number a person plans against is how a
 * company runs out of cash while its dashboard reads healthy.
 */
export default async function ObligationsPage() {
  const supabase = createSupabaseServerClient();
  const [session, board, categories, projects] = await Promise.all([
    requireSession(),
    loadObligationBoard(supabase),
    loadCategories(supabase),
    loadProjectOptions(supabase),
  ]);
  const canEdit = sessionCan(session, 'move_money');

  const {
    receivables,
    payables,
    receivableSummary,
    payableSummary,
    receivableAging,
    payableAging,
    projection,
    likelySettled,
    asOf,
  } = board;

  const nothing = receivables.length === 0 && payables.length === 0;

  return (
    <>
      <PageHeader
        title="Owed & owing"
        subtitle="Money that is going to move, and what the bank balance looks like once it has."
        action={
          canEdit ? <ObligationEditor categories={categories} projects={projects} /> : undefined
        }
      />

      {nothing ? (
        <Card>
          <EmptyState
            title="Nothing recorded yet"
            body={
              canEdit
                ? 'Record an invoice a client owes, or a bill AHN owes — payroll, a retainer, a tax payment, a venue deposit. Until they are here, the cash figure on every other page counts money that is already committed.'
                : 'Nobody has recorded a receivable or a commitment yet.'
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Cash today"
              value={formatMoney(projection.cashTodayUsdMinor)}
              hint="What the accounts hold right now"
            />
            <StatTile
              label={`Owed out, next ${projection.horizonDays} days`}
              value={formatMoney(projection.obligationsDueUsdMinor)}
              hint={`Through ${formatDayLabel(projection.through)}`}
              tone="outflow"
            />
            <StatTile
              label="Cash after commitments"
              value={formatMoney(projection.committedCashUsdMinor)}
              hint={
                projection.shortfall
                  ? `Short from ${projection.shortfallDate ? formatDayLabel(projection.shortfallDate) : 'inside the window'}`
                  : 'What is genuinely spendable'
              }
              tone={projection.shortfall ? 'outflow' : 'inflow'}
              emphasis
            />
            <StatTile
              label="Overdue in"
              value={formatMoney(receivableSummary.overdueUsdMinor)}
              hint={
                receivableSummary.oldestOverdueDays === null
                  ? 'Nothing past due'
                  : `Oldest is ${receivableSummary.oldestOverdueDays} days over`
              }
              tone={receivableSummary.overdueCount > 0 ? 'warn' : 'neutral'}
            />
          </div>

          <FormulaNote>
            Cash after commitments is today&rsquo;s balance minus everything owed inside the
            window. Receivables are excluded from it on purpose: a bill is a promise AHN has to
            keep, an invoice is a promise somebody else made. With the{' '}
            {formatMoney(projection.receivablesDueUsdMinor)} expected in, the same window ends at{' '}
            {formatMoney(projection.withReceivablesUsdMinor)} &mdash; the optimistic figure, and
            not the one to plan against.
          </FormulaNote>

          {projection.shortfall && (
            <div className="mt-5">
              <Callout tone="outflow" title="The commitments exceed the cash">
                Meeting everything due in the next {projection.horizonDays} days leaves{' '}
                {formatMoney(projection.committedCashUsdMinor)}
                {projection.shortfallDate
                  ? `, first going short on ${formatDayLabel(projection.shortfallDate)}.`
                  : '.'}{' '}
                Collecting {formatMoney(projection.receivablesDueUsdMinor)} of outstanding
                invoices would cover it, which makes the overdue list below the most useful thing
                on this page.
              </Callout>
            </div>
          )}

          {likelySettled.length > 0 && (
            <div className="mt-5">
              <Callout tone="warn" title="These may already have been paid">
                {likelySettled.length} open item{likelySettled.length === 1 ? '' : 's'}{' '}
                {likelySettled.length === 1 ? 'matches' : 'match'} a payment already in the ledger by
                amount and date. Until they are marked settled,
                the figure above subtracts them a second time &mdash; so it is understating what is
                spendable. Matching on amount and date is a heuristic and it is sometimes wrong,
                which is why nothing is settled automatically.
                <ul className="mt-2 space-y-1">
                  {likelySettled.slice(0, 6).map((m) => (
                    <li key={m.obligation.id} className="text-[12px]">
                      · {m.obligation.counterparty_name ?? 'Unnamed'}{' '}
                      {formatMoney(m.obligation.amount_minor)} — a payment{' '}
                      {m.daysApart === 0 ? 'on the same day' : `${m.daysApart} days apart`} (
                      <Link
                        href={`/transactions/${m.transaction.id}`}
                        className="underline underline-offset-2"
                      >
                        see it
                      </Link>
                      ){' '}
                      <SettleButton
                        id={m.obligation.id}
                        suggestedTxnId={m.transaction.id}
                        canEdit={canEdit}
                      />
                    </li>
                  ))}
                </ul>
              </Callout>
            </div>
          )}

          <div className="mt-7 grid gap-5 lg:grid-cols-2">
            <Side
              title="Owed to AHN"
              subtitle="Spec §17 — invoices out"
              summary={receivableSummary}
              aging={receivableAging}
              rows={receivables}
              asOf={asOf}
              canEdit={canEdit}
              tone="inflow"
            />
            <Side
              title="AHN owes"
              subtitle="Spec §18 — bills and commitments"
              summary={payableSummary}
              aging={payableAging}
              rows={payables}
              asOf={asOf}
              canEdit={canEdit}
              tone="outflow"
            />
          </div>
        </>
      )}
    </>
  );
}

function Side({
  title,
  subtitle,
  summary,
  aging,
  rows,
  asOf,
  canEdit,
  tone,
}: {
  title: string;
  subtitle: string;
  summary: { dueUsdMinor: number; overdueUsdMinor: number; paidUsdMinor: number; count: number };
  aging: AgingLine[];
  rows: Obligation[];
  asOf: string;
  canEdit: boolean;
  tone: 'inflow' | 'outflow';
}) {
  const outstanding = rows
    .filter((o) => o.status === 'open' || o.status === 'draft')
    .sort((a, b) => a.due_on.localeCompare(b.due_on));

  const withAmounts = aging.filter((line) => line.count > 0);

  return (
    <section>
      <SectionHeader title={title} subtitle={subtitle} />
      <Card padded={false}>
        <div className="grid gap-4 border-b border-[var(--line)] p-5 sm:grid-cols-3">
          <Figure label="Not yet due" value={summary.dueUsdMinor} />
          <Figure label="Overdue" value={summary.overdueUsdMinor} warn={summary.overdueUsdMinor > 0} />
          <Figure label="Settled" value={summary.paidUsdMinor} />
        </div>

        {withAmounts.length > 0 && (
          <ul className="divide-y divide-[var(--line)] border-b border-[var(--line)]">
            {withAmounts.map((line) => (
              <li key={line.bucket} className="flex items-center justify-between gap-4 px-5 py-2.5">
                <span className="muted text-[12.5px]">
                  {line.label}
                  <span className="faint ml-2">
                    {line.count} item{line.count === 1 ? '' : 's'}
                  </span>
                </span>
                <span
                  className="tabular text-[13px]"
                  style={{
                    color:
                      line.bucket !== 'not_due' && line.bucket !== 'current'
                        ? 'var(--warn)'
                        : undefined,
                  }}
                >
                  {formatMoney(line.amountUsdMinor)}
                </span>
              </li>
            ))}
          </ul>
        )}

        {outstanding.length === 0 ? (
          <div className="p-5">
            <p className="muted text-[13px]">Nothing outstanding.</p>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {outstanding.map((o) => {
              const bucket = agingBucket(o.due_on, asOf);
              const overdue = bucket !== 'not_due' && bucket !== 'current';
              return (
                <li key={o.id} className="flex items-start justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium">
                      {o.counterparty_name ?? 'Unnamed'}
                      {overdue && (
                        <span className="ml-2">
                          <Badge tone="warn">overdue</Badge>
                        </span>
                      )}
                      {o.is_recurring && (
                        <span className="ml-2">
                          <Badge>recurring</Badge>
                        </span>
                      )}
                    </p>
                    <p className="muted mt-0.5 text-[12px]">
                      {o.description ?? o.reference ?? '—'} · due {formatDayLabel(o.due_on)}
                      {o.category ? ` · ${categoryLabel(o.category)}` : ''}
                    </p>
                    <p className="mt-1">
                      <SettleButton id={o.id} canEdit={canEdit} />
                    </p>
                  </div>
                  <p
                    className="tabular shrink-0 text-[13px] font-medium"
                    style={{ color: tone === 'inflow' ? 'var(--inflow)' : 'var(--outflow)' }}
                  >
                    {formatMoney(o.amount_minor)}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );
}

function Figure({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div>
      <p className="faint text-[11px] font-semibold uppercase tracking-[0.05em]">{label}</p>
      <p
        className="tabular mt-1 text-[16px] font-semibold"
        style={{ color: warn ? 'var(--warn)' : undefined }}
      >
        {formatMoney(value)}
      </p>
    </div>
  );
}
