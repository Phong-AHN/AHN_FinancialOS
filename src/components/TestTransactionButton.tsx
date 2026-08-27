'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { buttonClass, Badge } from '@/components/ui';

interface Delivery {
  channel: string;
  status: 'sent' | 'failed' | 'skipped' | 'pending';
  error: string | null;
  severity: string;
  title: string;
}

interface TestResponse {
  ok: boolean;
  transactionId?: string;
  url?: string;
  matched?: boolean;
  deliveries?: Delivery[];
  error?: string;
}

/**
 * MVP Plan Day 4: "create a test transaction → receive the alert within seconds",
 * and Day 7: "one end-to-end test transaction in front of the CEO".
 *
 * Two buttons because the two paths differ in what they prove:
 *   - money in  → the everyday info alert on Slack + email
 *   - money out → clears the large-outflow threshold, so it also exercises the
 *     warning severity, the SMS channel, and the per-severity Slack routing
 *
 * The transaction is quarantined server-side (inactive, non-cash account, flagged
 * as an internal transfer) so no dashboard figure moves.
 */
export function TestTransactionButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<TestResponse | null>(null);

  async function fire(direction: 'inflow' | 'outflow') {
    setBusy(direction);
    setResult(null);
    try {
      const res = await fetch('/api/alerts/test-transaction', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ direction }),
      });
      const json = (await res.json()) as TestResponse;
      setResult(json);
      if (json.ok) startTransition(() => router.refresh());
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : 'Test failed.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClass('primary')}
          disabled={busy !== null || pending}
          onClick={() => fire('inflow')}
        >
          {busy === 'inflow' ? 'Firing…' : 'Test money in ($12,500)'}
        </button>
        <button
          type="button"
          className={buttonClass('secondary')}
          disabled={busy !== null || pending}
          onClick={() => fire('outflow')}
        >
          {busy === 'outflow' ? 'Firing…' : 'Test large outflow ($8,000)'}
        </button>
      </div>

      {result && !result.ok && (
        <p className="text-[12.5px]" style={{ color: 'var(--outflow)' }}>
          {result.error}
        </p>
      )}

      {result?.ok && (
        <div className="rounded-lg border border-[var(--line)] p-3">
          {result.matched === false ? (
            <p className="text-[12.5px]" style={{ color: 'var(--warn)' }}>
              The transaction was created but matched no enabled rule — check the rules above.
            </p>
          ) : (
            <>
              <p className="mb-2 text-[12.5px] font-medium">
                Alert fired. Delivery per channel:
              </p>
              <ul className="space-y-1.5">
                {result.deliveries?.map((d) => (
                  <li key={d.channel} className="flex items-start gap-2 text-[12.5px]">
                    <span className="w-16 shrink-0 capitalize">{d.channel.replace('_', '-')}</span>
                    <Badge
                      tone={d.status === 'sent' ? 'inflow' : d.status === 'failed' ? 'outflow' : 'neutral'}
                    >
                      {d.status}
                    </Badge>
                    {d.error && <span className="faint flex-1">{d.error}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.url && (
            <Link
              href={result.url}
              className="mt-3 inline-block text-[12.5px] underline underline-offset-2"
            >
              Open the test transaction →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
