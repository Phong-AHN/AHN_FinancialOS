'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui';

interface TestResponse {
  ok: boolean;
  results?: Array<{ channel: string; ok: boolean; skipped?: boolean; error?: string }>;
  error?: string;
}

/**
 * End-to-end delivery check - MVP Plan Day 4 ("create a test transaction ->
 * receive the alert within seconds") and Day 7 (demo in front of the CEO).
 *
 * Sends a clearly-labelled test message on every configured channel. It does
 * not create a fake transaction: seeding invented money into the ledger to test
 * a notification would be a poor trade.
 */
export function TestAlertButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setSummary(null);
    try {
      const res = await fetch('/api/alerts/test', { method: 'POST' });
      const json = (await res.json()) as TestResponse;

      if (!res.ok || !json.ok) {
        setSummary(json.error ?? 'Test failed.');
      } else {
        const parts = (json.results ?? []).map(
          (r) => `${r.channel}: ${r.ok ? 'delivered' : r.skipped ? 'not configured' : `failed (${r.error})`}`,
        );
        setSummary(parts.join(' · ') || 'No channels configured.');
        startTransition(() => router.refresh());
      }
    } catch (err) {
      setSummary(err instanceof Error ? err.message : 'Test failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {summary && <span className="faint max-w-[420px] text-right text-[11.5px]">{summary}</span>}
      <button type="button" onClick={send} disabled={busy || pending} className={buttonClass('secondary')}>
        {busy ? 'Sending…' : 'Send test alert'}
      </button>
    </div>
  );
}
