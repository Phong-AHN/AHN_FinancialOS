'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui';

interface SyncResponse {
  ok: boolean;
  results?: Array<{ provider: string; inserted: number; error?: string }>;
  alerts?: { transactionsAlerted: number; notificationsSent: number };
  error?: string;
}

/**
 * Manual "Sync now". The cron runs every 5-10 minutes on its own (MVP Plan
 * section 3), but a CEO watching for a specific wire should not have to wait
 * for the next tick.
 */
export function SyncButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function runSync() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/sync', { method: 'POST' });
      const json = (await res.json()) as SyncResponse;

      if (!res.ok || !json.ok) {
        setMessage(json.error ?? 'Sync failed.');
      } else {
        const inserted = json.results?.reduce((sum, r) => sum + r.inserted, 0) ?? 0;
        const failed = json.results?.filter((r) => r.error) ?? [];
        setMessage(
          `${inserted} new transaction${inserted === 1 ? '' : 's'}` +
            (json.alerts?.notificationsSent ? `, ${json.alerts.notificationsSent} alerts sent` : '') +
            (failed.length ? ` · ${failed.map((f) => `${f.provider}: ${f.error}`).join('; ')}` : ''),
        );
        startTransition(() => router.refresh());
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Sync failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {message && <span className="faint max-w-[380px] text-right text-[11.5px]">{message}</span>}
      <button
        type="button"
        onClick={runSync}
        disabled={busy || pending}
        className={buttonClass('secondary')}
      >
        {busy ? 'Syncing…' : pending ? 'Refreshing…' : 'Sync now'}
      </button>
    </div>
  );
}
