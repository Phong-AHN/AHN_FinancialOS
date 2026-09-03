import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth';
import { loadExplainBoard } from '@/lib/data';
import { formatMoney, formatPercent } from '@/lib/money';
import { formatDayLabel } from '@/lib/dates';
import { categoryLabel } from '@/lib/categorize';
import type { Driver, PeriodComparison } from '@/lib/calc/explain';
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
 * What changed, and why - Spec section 20, the deterministic half.
 *
 * Section 20 asks an AI layer to "interpret deterministic financial data rather
 * than calculate foundational accounting numbers itself". Nothing on this page
 * is AI. It is the arithmetic that layer would read, and it is useful without
 * one: where the cash went, who moved, and which payments are unusual for the
 * vendor that made them.
 */
export default async function ExplainPage({
  searchParams,
}: {
  searchParams: { days?: string };
}) {
  const windowDays = pickWindow(searchParams.days);
  const supabase = createSupabaseServerClient();
  const [, board] = await Promise.all([
    requireSession(),
    loadExplainBoard(supabase, undefined, windowDays),
  ]);

  const { cashChange, revenue, spending, anomalies, asOf } = board;
  const fell = cashChange.netChangeUsdMinor < 0;
  const uncategorised = cashChange.outflowDrivers.find((d) => d.label === 'uncategorized');

  return (
    <>
      <PageHeader
        title="What changed"
        subtitle="Where the cash went, who moved, and what looks unusual — all arithmetic, none of it a guess."
      />

      <div className="mb-5 flex flex-wrap gap-2">
        {WINDOWS.map((days) => (
          <Link
            key={days}
            href={`/explain?days=${days}`}
            className="rounded-full px-3 py-1.5 text-[12.5px] font-medium"
            style={{
              background: days === windowDays ? 'var(--brand-soft)' : 'var(--surface-sunk)',
              color: days === windowDays ? 'var(--brand)' : 'var(--text-muted)',
            }}
          >
            Last {days} days
          </Link>
        ))}
      </div>

      {!cashChange.reconciles && (
        <div className="mb-5">
          <Callout tone="outflow" title="This breakdown does not add up">
            Opening plus money in, less money out, does not equal the closing balance. Something
            below is wrong and it is better to say so than to show figures that quietly disagree
            with the balance above them.
          </Callout>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={`Cash on ${formatDayLabel(cashChange.from)}`}
          value={formatMoney(cashChange.openingUsdMinor)}
        />
        <StatTile
          label="Money in"
          value={formatMoney(cashChange.inflowUsdMinor)}
          hint="Transfers between our own accounts excluded"
          tone="inflow"
        />
        <StatTile
          label="Money out"
          value={formatMoney(cashChange.outflowUsdMinor)}
          tone="outflow"
        />
        <StatTile
          label={`Cash on ${formatDayLabel(asOf)}`}
          value={formatMoney(cashChange.closingUsdMinor)}
          hint={`${fell ? 'Down' : 'Up'} ${formatMoney(Math.abs(cashChange.netChangeUsdMinor))}`}
          tone={fell ? 'outflow' : 'inflow'}
          emphasis
        />
      </div>

      <FormulaNote>
        Opening balance plus money in, less money out, equals the closing balance — checked
        exactly, in whole cents. Money moved between AHN&rsquo;s own accounts is counted on
        neither side: it nets to zero across the whole position, and including it would inflate
        both figures by the same amount while telling you nothing.
      </FormulaNote>

      {uncategorised && uncategorised.share > 0.1 && (
        <div className="mt-5">
          {/* The heading states the real share. Hardcoding "a quarter" reads fine
              at 26% and is a lie at 60%, and a heading nobody can trust is
              worse than no heading. */}
          <Callout
            tone="warn"
            title={`${formatPercent(uncategorised.share, 0)} of the spending has no category`}
          >
            {formatMoney(uncategorised.amountUsdMinor)} across {uncategorised.count} payments is
            uncategorised. Every breakdown on this page and every budget elsewhere is that much
            less useful until it is classified.{' '}
            <Link href="/transactions?uncategorized=1" className="underline underline-offset-2">
              Categorise them
            </Link>
            .
          </Callout>
        </div>
      )}

      <div className="mt-7 grid gap-5 lg:grid-cols-2">
        <Drivers
          title="Where the money went"
          drivers={cashChange.outflowDrivers}
          total={cashChange.outflowUsdMinor}
          tone="outflow"
          from={cashChange.from}
          to={asOf}
        />
        <Drivers
          title="Where it came from"
          drivers={cashChange.inflowDrivers}
          total={cashChange.inflowUsdMinor}
          tone="inflow"
          from={cashChange.from}
          to={asOf}
        />
      </div>

      <section className="mt-7">
        <SectionHeader
          title="Biggest single movements"
          subtitle={`${formatDayLabel(cashChange.from)} to ${formatDayLabel(asOf)}`}
        />
        <Card padded={false}>
          {cashChange.largest.length === 0 ? (
            <EmptyState title="Nothing moved in this window" body="Try a longer period." />
          ) : (
            <ul className="divide-y divide-[var(--line)]">
              {cashChange.largest.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <Link
                      href={`/transactions/${m.id}`}
                      className="truncate text-[13px] font-medium hover:underline"
                    >
                      {m.label}
                    </Link>
                    <p className="muted mt-0.5 text-[12px]">{formatDayLabel(m.date)}</p>
                  </div>
                  <p
                    className="tabular shrink-0 text-[13px] font-medium"
                    style={{
                      color: m.direction === 'inflow' ? 'var(--inflow)' : 'var(--outflow)',
                    }}
                  >
                    {m.direction === 'inflow' ? '+' : '−'}
                    {formatMoney(m.amountUsdMinor)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <div className="mt-7 grid gap-5 lg:grid-cols-2">
        <Movers
          title="Who moved, on the money in"
          comparison={revenue}
          windowDays={windowDays}
          tone="inflow"
        />
        <Movers
          title="Who moved, on the money out"
          comparison={spending}
          windowDays={windowDays}
          tone="outflow"
        />
      </div>

      <section className="mt-7">
        <SectionHeader
          title="Unusual for the vendor that charged it"
          subtitle="Compared against each vendor's own history, not against a company-wide threshold"
        />
        <Card padded={false}>
          {anomalies.length === 0 ? (
            <EmptyState
              title="Nothing out of character"
              body="Every recent payment sits within what its own vendor usually charges. A vendor needs at least four payments before there is an expectation to be unusual against."
            />
          ) : (
            <ul className="divide-y divide-[var(--line)]">
              {anomalies.map((a) => (
                <li key={a.transaction.id} className="flex items-start justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium">
                      {a.label}
                      <span className="ml-2">
                        <Badge tone="warn">{a.multiple}× usual</Badge>
                      </span>
                    </p>
                    <p className="muted mt-0.5 text-[12px] leading-relaxed">{a.reason}</p>
                    <Link
                      href={`/transactions/${a.transaction.id}`}
                      className="mt-1 inline-block text-[12px] underline underline-offset-2"
                    >
                      Open the payment
                    </Link>
                  </div>
                  <p className="tabular shrink-0 text-[13px] font-medium">
                    {formatMoney(a.amountUsdMinor)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <FormulaNote>
          A vendor is measured against its own median, not against a flat figure. A flat
          threshold fires on every payroll run — which is not news — and stays silent on a $300
          charge from a supplier that has never once charged more than $20, which is the charge
          worth looking at. One line per vendor: several at once means their amounts vary with
          something rather than being fixed.
        </FormulaNote>
      </section>

      <div className="mt-7">
        <Callout tone="neutral" title="No interpretation, only arithmetic">
          Spec §20 asks for an AI layer that <em>interprets</em> deterministic financial data
          rather than computing the accounting itself. This page is that deterministic data.
          Nothing here suggests what to do about any of it — that judgement needs context this
          system does not have, and a confident recommendation built on a sandbox ledger would be
          worse than none.
        </Callout>
      </div>
    </>
  );
}

const WINDOWS = [30, 90, 180] as const;

function pickWindow(raw: string | undefined): number {
  const n = Number(raw);
  return WINDOWS.includes(n as (typeof WINDOWS)[number]) ? n : 30;
}

function Drivers({
  title,
  drivers,
  total,
  tone,
  from,
  to,
}: {
  title: string;
  drivers: Driver[];
  total: number;
  tone: 'inflow' | 'outflow';
  from: string;
  to: string;
}) {
  return (
    <section>
      <SectionHeader title={title} />
      <Card padded={false}>
        {drivers.length === 0 ? (
          <div className="p-5">
            <p className="muted text-[13px]">Nothing on this side.</p>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {drivers.map((d) => (
              <li key={d.label} className="p-4">
                <div className="flex items-baseline justify-between gap-4">
                  <Link
                    href={`/transactions?category=${encodeURIComponent(d.label)}&from=${from}&to=${to}&direction=${tone}`}
                    className="truncate text-[13px] font-medium hover:underline"
                  >
                    {categoryLabel(d.label)}
                  </Link>
                  <span className="tabular shrink-0 text-[13px]">
                    {formatMoney(d.amountUsdMinor)}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div
                    className="h-1.5 flex-1 overflow-hidden rounded-full"
                    style={{ background: 'var(--surface-sunk)' }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(2, Math.round(d.share * 100))}%`,
                        background: tone === 'inflow' ? 'var(--inflow)' : 'var(--outflow)',
                      }}
                    />
                  </div>
                  <span className="faint tabular w-16 shrink-0 text-right text-[11px]">
                    {formatPercent(d.share, 0)} · {d.count}×
                  </span>
                </div>
              </li>
            ))}
            <li className="flex items-baseline justify-between gap-4 p-4">
              <span className="text-[13px] font-semibold">Total</span>
              <span className="tabular text-[13px] font-semibold">{formatMoney(total)}</span>
            </li>
          </ul>
        )}
      </Card>
    </section>
  );
}

function Movers({
  title,
  comparison,
  windowDays,
  tone,
}: {
  title: string;
  comparison: PeriodComparison;
  windowDays: number;
  tone: 'inflow' | 'outflow';
}) {
  const rose = comparison.changeUsdMinor > 0;

  return (
    <section>
      <SectionHeader
        title={title}
        subtitle={`Against the ${windowDays} days before that`}
      />
      <Card padded={false}>
        <div className="border-b border-[var(--line)] p-5">
          <p className="tabular text-[18px] font-semibold">
            {formatMoney(comparison.priorUsdMinor)} &rarr; {formatMoney(comparison.currentUsdMinor)}
          </p>
          <p
            className="mt-1 text-[12.5px]"
            style={{
              color:
                (tone === 'inflow') === rose ? 'var(--inflow)' : 'var(--outflow)',
            }}
          >
            {rose ? '+' : ''}
            {formatMoney(comparison.changeUsdMinor)}
            {/* Growth from nothing is undefined, not infinite. */}
            {comparison.changeRatio !== null && ` · ${formatPercent(comparison.changeRatio, 0)}`}
          </p>
        </div>

        {comparison.movers.length === 0 ? (
          <div className="p-5">
            <p className="muted text-[13px]">Nothing moved between the two periods.</p>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {comparison.movers.slice(0, 8).map((m) => (
              <li key={m.label} className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">
                    {m.label}
                    {m.isNew && (
                      <span className="ml-2">
                        <Badge tone="brand">new</Badge>
                      </span>
                    )}
                    {m.isGone && (
                      <span className="ml-2">
                        <Badge tone="warn">stopped</Badge>
                      </span>
                    )}
                  </p>
                  <p className="muted mt-0.5 text-[12px]">
                    {formatMoney(m.priorUsdMinor)} &rarr; {formatMoney(m.currentUsdMinor)}
                  </p>
                </div>
                <p
                  className="tabular shrink-0 text-[13px] font-medium"
                  style={{
                    color: m.changeUsdMinor > 0 ? 'var(--inflow)' : 'var(--outflow)',
                  }}
                >
                  {m.changeUsdMinor > 0 ? '+' : ''}
                  {formatMoney(m.changeUsdMinor)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
