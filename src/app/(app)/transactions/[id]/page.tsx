import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth';
import { loadAuditForRecord, loadTransaction } from '@/lib/data';
import { formatDateTime, relativeTime } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import { categoryLabel } from '@/lib/categorize';
import { TransactionEditor } from '@/components/TransactionEditor';
import type { NotificationRow, TransactionWithContext } from '@/lib/types';
import {
  Badge,
  Callout,
  Card,
  Money,
  PageHeader,
  ReconBadge,
  SectionHeader,
  SeverityBadge,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The bottom of every drill-down - Spec section 28: "Every imported dollar can
 * be traced to its source transaction."
 *
 * So this page shows not just the normalised row but the raw payload the source
 * system actually sent, the alerts it triggered, and every hand edit made to it.
 */
export default async function TransactionDetailPage({ params }: { params: { id: string } }) {
  const session = await requireSession();
  const supabase = createSupabaseServerClient();

  const txn = await loadTransaction(supabase, params.id);
  if (!txn) notFound();

  const [audit, notificationsRes, duplicateOf] = await Promise.all([
    loadAuditForRecord(supabase, 'transactions', txn.id),
    supabase
      .from('notifications')
      .select('*')
      .eq('transaction_id', txn.id)
      .order('created_at', { ascending: false }),
    txn.duplicate_of_id ? loadTransaction(supabase, txn.duplicate_of_id) : Promise.resolve(null),
  ]);

  const notifications = (notificationsRes.data ?? []) as NotificationRow[];
  const isInflow = txn.direction === 'inflow';

  return (
    <>
      <PageHeader
        title={txn.counterparty?.name ?? txn.description ?? 'Transaction'}
        subtitle={`${isInflow ? 'Money in' : 'Money out'} · ${txn.txn_date} · ${txn.account?.name ?? 'Unknown account'}`}
        action={
          <Link href="/transactions" className="muted text-[13px] underline underline-offset-2">
            ← Back to transactions
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-4">
        <p className="tabular text-[34px] font-semibold tracking-tight" style={{ color: isInflow ? 'var(--inflow)' : 'var(--outflow)' }}>
          {isInflow ? '+' : '−'}
          {formatMoney(txn.amount_minor, txn.currency).replace(/^[−+]/, '')}
        </p>
        {txn.currency !== 'USD' && txn.amount_usd_minor !== null && (
          <span className="muted text-[13px]">
            = {formatMoney(txn.amount_usd_minor)} at {txn.fx_rate} USD/{txn.currency}
          </span>
        )}
        <ReconBadge status={txn.reconciliation_status} />
        {txn.is_internal_transfer && <Badge>Internal transfer</Badge>}
        {txn.is_subscription && <Badge tone="brand">Subscription</Badge>}
      </div>

      {txn.reconciliation_status === 'possible_duplicate' && (
        <div className="mb-6">
          <Callout tone="warn" title="Held out of cash totals">
            This looks like the same activity as{' '}
            {duplicateOf ? (
              <Link href={`/transactions/${duplicateOf.id}`} className="underline underline-offset-2">
                the {duplicateOf.source_system} record
              </Link>
            ) : (
              'another record'
            )}
            , so it is excluded from cash, burn and revenue until someone confirms. {txn.notes}
          </Callout>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        {/* ── Facts ─────────────────────────────────────────────────────── */}
        <Card>
          <SectionHeader title="Transaction" />
          <dl className="divide-y divide-[var(--line)] text-[13px]">
            <Field label="Date" value={txn.txn_date} />
            <Field label="Posted" value={formatDateTime(txn.posted_at)} />
            <Field label="Amount" value={<Money minor={txn.amount_minor} currency={txn.currency} direction={txn.direction} />} />
            <Field label="Account" value={<Link href={`/transactions?account=${txn.account_id}`} className="underline underline-offset-2">{txn.account?.name ?? '—'}</Link>} />
            <Field
              label="Counterparty"
              value={
                txn.counterparty ? (
                  <Link href={`/transactions?q=${encodeURIComponent(txn.counterparty.name)}`} className="underline underline-offset-2">
                    {txn.counterparty.name}
                  </Link>
                ) : (
                  '—'
                )
              }
            />
            <Field label="Category" value={categoryLabel(txn.category)} />
            <Field label="Subcategory" value={txn.subcategory ?? '—'} />
            <Field label="Description" value={txn.description ?? '—'} />
            <Field label="Notes" value={txn.notes ?? '—'} />
          </dl>
        </Card>

        {/* ── Provenance ────────────────────────────────────────────────── */}
        <Card>
          <SectionHeader
            title="Where this came from"
            subtitle="The source key below is what stops this dollar being counted twice."
          />
          <dl className="divide-y divide-[var(--line)] text-[13px]">
            <Field label="Source system" value={<span className="capitalize">{txn.source_system.replace(/_/g, ' ')}</span>} />
            <Field label="Source ID" value={<code className="text-[11.5px]">{txn.external_txn_id}</code>} />
            <Field label="Internal ID" value={<code className="text-[11.5px]">{txn.id}</code>} />
            <Field label="First seen" value={`${formatDateTime(txn.created_at)} (${relativeTime(txn.created_at)})`} />
            <Field label="Last updated" value={formatDateTime(txn.updated_at)} />
            <Field label="Alerted" value={txn.alerted_at ? formatDateTime(txn.alerted_at) : 'Not yet processed'} />
          </dl>

          {txn.raw && (
            <details className="mt-4">
              <summary className="cursor-pointer text-[12.5px] font-medium">
                Raw payload from {txn.source_system.replace(/_/g, ' ')}
              </summary>
              <pre className="mt-2 max-h-[280px] overflow-auto rounded-lg bg-[var(--surface-sunk)] p-3 text-[11px] leading-relaxed">
                <code>{JSON.stringify(txn.raw, null, 2)}</code>
              </pre>
            </details>
          )}
        </Card>
      </div>

      {/* ── Edit ──────────────────────────────────────────────────────────── */}
      <div className="mt-4">
        <Card>
          <SectionHeader
            title="Correct this transaction"
            subtitle={
              session.user.role === 'owner'
                ? 'Every change is written to the audit log with the old value, the new value and your name.'
                : 'Read-only: editing financial data is restricted to the owner role.'
            }
          />
          <TransactionEditor transaction={serialize(txn)} canEdit={session.user.role === 'owner'} />
        </Card>
      </div>

      {/* ── Audit trail ───────────────────────────────────────────────────── */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card padded={false}>
          <div className="p-5 pb-0">
            <SectionHeader title="Edit history" subtitle="Spec §24 — append-only." />
          </div>
          {audit.length === 0 ? (
            <p className="faint px-5 pb-5 text-[13px]">No hand edits. This row is exactly as the source sent it.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Field</th>
                  <th>From → to</th>
                  <th>Who</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((entry) => (
                  <tr key={entry.id}>
                    <td className="muted whitespace-nowrap">{formatDateTime(entry.changed_at)}</td>
                    <td className="font-medium">{entry.field}</td>
                    <td>
                      <span className="faint line-through">{entry.old_value ?? 'empty'}</span>{' '}
                      <span>→ {entry.new_value ?? 'empty'}</span>
                      {entry.reason && <span className="faint mt-0.5 block text-[11.5px]">{entry.reason}</span>}
                    </td>
                    <td className="muted">{entry.user_email ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card padded={false}>
          <div className="p-5 pb-0">
            <SectionHeader title="Alerts sent" subtitle="Which channels this dollar went out on." />
          </div>
          {notifications.length === 0 ? (
            <p className="faint px-5 pb-5 text-[13px]">
              {txn.alerted_at
                ? 'Processed by the alert engine, but no rule matched.'
                : 'Not yet processed by the alert engine.'}
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Severity</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {notifications.map((n) => (
                  <tr key={n.id}>
                    <td className="font-medium capitalize">{n.channel.replace('_', '-')}</td>
                    <td>
                      <SeverityBadge severity={n.severity} />
                    </td>
                    <td>
                      <Badge tone={n.status === 'sent' ? 'inflow' : n.status === 'failed' ? 'outflow' : 'neutral'}>
                        {n.status}
                      </Badge>
                      {n.error && <span className="faint mt-0.5 block text-[11px]">{n.error}</span>}
                    </td>
                    <td className="muted whitespace-nowrap">{formatDateTime(n.sent_at ?? n.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-2.5">
      <dt className="faint shrink-0">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

/** Only the fields the editor needs, so nothing extra crosses to the client. */
function serialize(txn: TransactionWithContext) {
  return {
    id: txn.id,
    category: txn.category,
    subcategory: txn.subcategory,
    notes: txn.notes,
    is_internal_transfer: txn.is_internal_transfer,
    is_subscription: txn.is_subscription,
    is_recurring: txn.is_recurring,
    reconciliation_status: txn.reconciliation_status,
  };
}
