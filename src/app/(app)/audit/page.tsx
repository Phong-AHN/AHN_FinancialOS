import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireOwner } from '@/lib/auth';
import { formatDateTime } from '@/lib/dates';
import type { AuditLog } from '@/lib/types';
import { Callout, Card, EmptyState, PageHeader, StatTile } from '@/components/ui';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;

/**
 * The audit trail - Spec section 24.
 *
 * `audit_logs` carries an insert policy and no update or delete policy, so a
 * record of a financial edit cannot be altered or removed through the app,
 * including by the owner. That property is the whole value of the table.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  await requireOwner();
  const supabase = createSupabaseServerClient();

  const page = Math.max(1, Number(searchParams.page ?? '1') || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const { data, count } = await supabase
    .from('audit_logs')
    .select('*', { count: 'exact' })
    .order('changed_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  const entries = (data ?? []) as AuditLog[];
  const total = count ?? 0;
  const editors = new Set(entries.map((e) => e.user_email).filter(Boolean)).size;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Every hand edit to financial data: the old value, the new value, who and when."
      />

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <StatTile label="Recorded changes" value={total.toLocaleString('en-US')} hint="Since the first migration" />
        <StatTile label="People editing" value={String(editors)} hint="On this page of history" />
        <StatTile
          label="Most recent"
          value={entries[0] ? formatDateTime(entries[0].changed_at) : 'none'}
          hint={entries[0] ? `${entries[0].field} on ${entries[0].table_name}` : 'No edits yet'}
        />
      </div>

      <div className="mb-6">
        <Callout tone="brand" title="Append-only by construction">
          The table grants insert and select, and nothing else. There is no update or delete policy
          for any role, so a change to the financial record cannot be quietly rewritten later.
        </Callout>
      </div>

      <Card padded={false}>
        {entries.length === 0 ? (
          <EmptyState
            title="No edits recorded"
            body="Every transaction is exactly as its source delivered it. Correcting a category or note on a transaction will create the first entry."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Record</th>
                <th>Field</th>
                <th>Old value</th>
                <th>New value</th>
                <th>Who</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="muted whitespace-nowrap">{formatDateTime(entry.changed_at)}</td>
                  <td>
                    {entry.table_name === 'transactions' ? (
                      <Link href={`/transactions/${entry.record_id}`} className="hover:underline">
                        <span className="font-medium">transaction</span>
                        <span className="faint block text-[11px]">{entry.record_id.slice(0, 8)}…</span>
                      </Link>
                    ) : (
                      <>
                        <span className="font-medium">{entry.table_name}</span>
                        <span className="faint block text-[11px]">{entry.record_id.slice(0, 8)}…</span>
                      </>
                    )}
                  </td>
                  <td className="font-medium">{entry.field}</td>
                  <td className="faint max-w-[200px] truncate line-through">{entry.old_value ?? 'empty'}</td>
                  <td className="max-w-[200px] truncate">{entry.new_value ?? 'empty'}</td>
                  <td className="muted">{entry.user_email ?? 'system'}</td>
                  <td className="muted max-w-[220px] text-[12px]">{entry.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {pageCount > 1 && (
        <nav className="mt-4 flex items-center justify-between text-[12.5px]">
          <span className="faint">
            Page {page} of {pageCount}
          </span>
          <span className="flex gap-3">
            {page > 1 && (
              <Link href={`/audit?page=${page - 1}`} className="underline underline-offset-2">
                Previous
              </Link>
            )}
            {page < pageCount && (
              <Link href={`/audit?page=${page + 1}`} className="underline underline-offset-2">
                Next
              </Link>
            )}
          </span>
        </nav>
      )}
    </>
  );
}
