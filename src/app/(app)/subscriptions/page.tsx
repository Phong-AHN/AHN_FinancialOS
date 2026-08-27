import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth';
import { loadRecurringCharges } from '@/lib/data';
import { categoryLabel } from '@/lib/categorize';
import { cadenceLabel, type RecurringCharge } from '@/lib/subscriptions';
import { formatDayLabel } from '@/lib/dates';
import { formatMoney, formatPercent } from '@/lib/money';
import {
  Badge,
  Callout,
  Card,
  EmptyState,
  FormulaNote,
  Money,
  PageHeader,
  SectionHeader,
  StatTile,
} from '@/components/ui';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

/**
 * Recurring charges - Spec section 8.
 *
 * Everything here is derived from the payments themselves, never from the
 * `is_subscription` flag. That flag only ever finds vendors already written
 * into a rule list, and the charges worth catching are the ones nobody
 * remembered signing up for.
 *
 * Two claims this page refuses to make, because the payment data cannot
 * support either: that a charge is unused, and that cancelling it would save a
 * stated amount. Both need a person to say so, and both are what a
 * subscription dashboard is usually wrong about.
 */
export default async function SubscriptionsPage() {
  // Session check and detector run together; RLS is what actually filters the
  // rows, and a signed-out request is redirected before anything renders.
  const supabase = createSupabaseServerClient();
  const [, { charges, summary, scannedFrom, scanned }] = await Promise.all([
    requireSession(),
    loadRecurringCharges(supabase),
  ]);

  const topIncrease = summary.priceIncreases[0];

  return (
    <>
      <PageHeader
        title="Recurring charges"
        subtitle="What bills us again and again, found from the payments rather than from a list someone remembered to keep."
      />

      {charges.length === 0 ? (
        <Card>
          <EmptyState
            title="No recurring charges found yet"
            body={`Scanned ${scanned.toLocaleString()} payments since ${formatDayLabel(scannedFrom)}. A charge has to repeat at least three times, on a steady rhythm, at a steady price, before it counts as recurring.`}
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Monthly recurring"
              value={formatMoney(summary.monthlyRecurringUsdMinor)}
              hint={`${summary.count} charge${summary.count === 1 ? '' : 's'} still running`}
              tone="outflow"
              emphasis
            />
            <StatTile
              label="Annualised"
              value={formatMoney(summary.annualisedUsdMinor)}
              hint="What today's prices come to over a year"
              tone="outflow"
            />
            <StatTile
              label="Price increases"
              value={String(summary.priceIncreases.length)}
              hint={
                topIncrease
                  ? `Largest: ${formatPercent(topIncrease.priceChange, 0)} at ${topIncrease.vendorName}`
                  : 'No price has moved'
              }
              tone={summary.priceIncreases.length ? 'warn' : 'neutral'}
            />
            <StatTile
              label="Stopped billing"
              value={formatMoney(summary.lapsedAnnualUsdMinor)}
              hint={`${summary.lapsed.length} overdue by more than a full period`}
              tone={summary.lapsed.length ? 'warn' : 'neutral'}
            />
          </div>

          <FormulaNote>
            A charge counts as recurring when the same vendor bills at least three times, the
            gaps between the payments are all about the same length, and the amounts sit on one
            or two repeated prices. That last condition is what keeps a supplier you buy from
            most weeks out of this list: it has a rhythm, but it has no price.
          </FormulaNote>

          {summary.priceIncreases.length > 0 && (
            <section className="mt-7">
              <SectionHeader
                title="Prices that went up"
                subtitle="Measured against the amount billed before the most recent change"
              />
              <Card padded={false}>
                <ul className="divide-y divide-[var(--line)]">
                  {summary.priceIncreases.map((c) => (
                    <li key={c.vendorKey} className="flex items-center justify-between gap-4 p-4">
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium">{c.vendorName}</p>
                        <p className="muted mt-0.5 text-[12px]">
                          {formatMoney(c.previousAmountUsdMinor ?? 0)} &rarr;{' '}
                          {formatMoney(c.currentAmountUsdMinor)}
                          {c.priceChangedOn ? `, from ${formatDayLabel(c.priceChangedOn)}` : ''}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <Badge tone="warn">{formatPercent(c.priceChange, 0)}</Badge>
                        <p className="faint tabular mt-1 text-[11px]">
                          {formatMoney(extraPerYear(c))}/yr more
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}

          {summary.lapsed.length > 0 && (
            <section className="mt-7">
              <SectionHeader title="Stopped billing" subtitle="Overdue by more than one full period" />
              <Callout tone="warn">
                Worth checking rather than celebrating. A charge that stopped is either a
                cancellation nobody wrote down, or a payment that failed &mdash; and the second
                one takes the service away without warning.
              </Callout>
              <div className="mt-3">
                <Card padded={false}>
                  <ul className="divide-y divide-[var(--line)]">
                    {summary.lapsed.map((c) => (
                      <li
                        key={c.vendorKey}
                        className="flex items-center justify-between gap-4 p-4"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-medium">{c.vendorName}</p>
                          <p className="muted mt-0.5 text-[12px]">
                            Last billed {formatDayLabel(c.lastSeen)}, was due again{' '}
                            {formatDayLabel(c.nextExpected)}
                          </p>
                        </div>
                        <p className="tabular shrink-0 text-[13px]">
                          {formatMoney(c.annualisedUsdMinor)}/yr
                        </p>
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>
            </section>
          )}

          {summary.upcomingRenewals.length > 0 && (
            <section className="mt-7">
              <SectionHeader title="Due in the next 14 days" />
              <Card padded={false}>
                <ul className="divide-y divide-[var(--line)]">
                  {summary.upcomingRenewals.map((c) => (
                    <li key={c.vendorKey} className="flex items-center justify-between gap-4 p-4">
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium">{c.vendorName}</p>
                        <p className="muted mt-0.5 text-[12px]">
                          {formatDayLabel(c.nextExpected)} &middot; {cadenceLabel(c.cadence)}
                        </p>
                      </div>
                      <p className="tabular shrink-0 text-[13px]">
                        {formatMoney(c.currentAmountUsdMinor)}
                      </p>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}

          {summary.possibleDuplicates.length > 0 && (
            <section className="mt-7">
              <SectionHeader
                title="More than one vendor doing the same job"
                subtitle="A prompt for a person, not a verdict"
              />
              <Card padded={false}>
                <ul className="divide-y divide-[var(--line)]">
                  {summary.possibleDuplicates.map((group) => (
                    <li key={group.category} className="p-4">
                      <p className="text-[13px] font-medium">{categoryLabel(group.category)}</p>
                      <p className="muted mt-1 text-[12px] leading-relaxed">
                        {group.charges.map((c) => c.vendorName).join(', ')} &mdash;{' '}
                        {formatMoney(
                          group.charges.reduce((s, c) => s + c.monthlyEquivalentUsdMinor, 0),
                        )}
                        /mo between them. They may both be needed, so none of it is counted as a
                        saving.
                      </p>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}

          <section className="mt-7">
            <SectionHeader
              title="Every recurring charge"
              subtitle={`From ${scanned.toLocaleString()} payments since ${formatDayLabel(scannedFrom)}`}
            />
            <Card padded={false} className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-[var(--line)] text-left">
                    <Th>Vendor</Th>
                    <Th>Category</Th>
                    <Th>Every</Th>
                    <Th className="text-right">Amount</Th>
                    <Th className="text-right">Per year</Th>
                    <Th>Next expected</Th>
                    <Th className="text-right">Seen</Th>
                    <Th className="text-right">Confidence</Th>
                  </tr>
                </thead>
                <tbody>
                  {charges.map((c) => (
                    <tr key={c.vendorKey} className="border-b border-[var(--line)] last:border-0">
                      <Td>
                        <Link
                          href={`/transactions?q=${encodeURIComponent(c.vendorName)}`}
                          className="font-medium hover:underline"
                        >
                          {c.vendorName}
                        </Link>
                        {statusOf(c) && <span className="ml-2">{statusOf(c)}</span>}
                      </Td>
                      <Td className="muted">{categoryLabel(c.category)}</Td>
                      <Td className="muted">{cadenceLabel(c.cadence)}</Td>
                      <Td className="tabular text-right">
                        <Money minor={c.currentAmountUsdMinor} />
                      </Td>
                      <Td className="tabular text-right">
                        <Money minor={c.annualisedUsdMinor} />
                      </Td>
                      <Td className="muted tabular">{formatDayLabel(c.nextExpected)}</Td>
                      <Td className="muted tabular text-right">{c.occurrences}&times;</Td>
                      <Td
                        className="muted tabular text-right"
                        title={`Timing ${Math.round(c.timingConfidence * 100)}%, price steadiness ${Math.round(c.amountStability * 100)}%`}
                      >
                        {Math.round(c.confidence * 100)}%
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </section>

          <div className="mt-7">
            <Callout tone="neutral" title="What this page cannot tell you">
              Payments record what left the bank. They never record who owns a tool, whether
              anyone still uses it, or how much notice cancelling it needs. Those are the three
              answers that turn this list into a decision, and all three have to come from a
              person.
            </Callout>
          </div>
        </>
      )}
    </>
  );
}

/**
 * The annual cost the most recent price rise added.
 *
 * Both amounts are annualised on the SAME cadence, so this is the increase and
 * nothing else. Comparing a new price against an old annual total would fold
 * any change in billing frequency into a number labelled "price".
 */
function extraPerYear(c: RecurringCharge): number {
  if (c.previousAmountUsdMinor === null || c.currentAmountUsdMinor === 0) return 0;
  const perYear = c.annualisedUsdMinor / c.currentAmountUsdMinor;
  return Math.round((c.currentAmountUsdMinor - c.previousAmountUsdMinor) * perYear);
}

function statusOf(c: RecurringCharge): ReactNode {
  if (c.daysOverdue > c.intervalDays) return <Badge tone="warn">stopped</Badge>;
  if (c.priceChange !== null && c.priceChange > 0.005) {
    return <Badge tone="warn">{formatPercent(c.priceChange, 0)}</Badge>;
  }
  return null;
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

function Td({
  children,
  className = '',
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td className={`px-4 py-2.5 ${className}`} title={title}>
      {children}
    </td>
  );
}
