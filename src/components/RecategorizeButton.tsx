'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui';

interface Result {
  ok: boolean;
  examined?: number;
  updated?: number;
  protected?: number;
  stillUncategorized?: number;
  error?: string;
}

/**
 * Catch-up pass for the categorisation rules.
 *
 * Rules only run at ingest, so rows imported before a rule existed keep the old
 * verdict. This re-runs them — skipping anything a person has already decided.
 */
export function RecategorizeButton({ canEdit }: { canEdit: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/transactions/recategorize', { method: 'POST' });
      const json = (await res.json()) as Result;
      setResult(json);
      if (json.ok) startTransition(() => router.refresh());
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : 'Failed.' });
    } finally {
      setBusy(false);
    }
  }

  if (!canEdit) return null;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={run} disabled={busy || pending} className={buttonClass('secondary')}>
        {busy ? 'Re-running…' : 'Re-run categorisation'}
      </button>
      {result && (
        <span className="text-[12px]" style={{ color: result.ok ? 'var(--text-muted)' : 'var(--outflow)' }}>
          {result.ok
            ? `${result.updated} categorised, ${result.stillUncategorized} still unmatched` +
              (result.protected ? `, ${result.protected} left alone (edited by hand)` : '')
            : result.error}
        </span>
      )}
    </div>
  );
}
