'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui';
import type { ReconStatus } from '@/lib/types';

/**
 * Resolve one suspected duplicate.
 *
 * Two outcomes, both explicit, neither destructive: confirm it (permanently
 * excluded from every total, row kept for the trail) or reject it (restored to
 * the totals). Deleting was never an option - spec section 28 requires every
 * imported dollar to remain traceable, including the ones we decided not to
 * count.
 */
export function ReconcileActions({
  transactionId,
  canEdit,
}: {
  transactionId: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<ReconStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resolve(status: ReconStatus, reason: string) {
    setBusy(status);
    setError(null);
    try {
      const res = await fetch(`/api/transactions/${transactionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reconciliation_status: status, reason }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: string };
        setError(json.error ?? 'Could not save.');
      } else {
        startTransition(() => router.refresh());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setBusy(null);
    }
  }

  if (!canEdit) return <span className="faint text-[11.5px]">Owner only</span>;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <button
          type="button"
          className={buttonClass('secondary')}
          disabled={busy !== null || pending}
          onClick={() => resolve('duplicate_ignored', 'Confirmed as a duplicate from the reconcile queue')}
        >
          {busy === 'duplicate_ignored' ? 'Saving…' : 'Confirm duplicate'}
        </button>
        <button
          type="button"
          className={buttonClass('secondary')}
          disabled={busy !== null || pending}
          onClick={() => resolve('reconciled', 'Not a duplicate — restored to totals from the reconcile queue')}
        >
          {busy === 'reconciled' ? 'Saving…' : 'Not a duplicate'}
        </button>
      </div>
      {error && <span className="text-[11.5px]" style={{ color: 'var(--outflow)' }}>{error}</span>}
    </div>
  );
}
