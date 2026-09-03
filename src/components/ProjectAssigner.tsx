'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { buttonClass } from '@/components/ui';

interface Option {
  id: string;
  name: string;
  kind: 'project' | 'event';
}

/**
 * Attribute one transaction to a project or event - Spec section 12.
 *
 * "No project" is a first-class choice, not an empty state. Most overhead
 * genuinely belongs to nothing, and a control that pushes every line onto some
 * project would spread rent and salaries across client work until every project
 * looked worse than it is and the overhead disappeared from view.
 */
export function ProjectAssigner({
  transactionId,
  current,
  options,
  canEdit,
}: {
  transactionId: string;
  current: string | null;
  options: Option[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentName = options.find((o) => o.id === value)?.name;

  async function save(next: string) {
    setBusy(true);
    setError(null);
    const previous = value;
    setValue(next);
    try {
      const res = await fetch(`/api/transactions/${transactionId}/project`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: next || null }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!json.ok) {
        setValue(previous);
        setError(json.error ?? 'Could not save.');
        return;
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setValue(previous);
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  if (!canEdit) {
    return (
      <p className="muted text-[13px]">
        {currentName ? (
          <>
            Attributed to <span className="font-medium">{currentName}</span>.
          </>
        ) : (
          'Not attributed to any project.'
        )}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <select
        value={value}
        onChange={(e) => void save(e.target.value)}
        disabled={busy || pending || options.length === 0}
        style={{ minWidth: 240 }}
      >
        <option value="">No project — overhead</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
            {o.kind === 'event' ? ' (event)' : ''}
          </option>
        ))}
      </select>

      {options.length === 0 && (
        <span className="faint text-[12px]">
          No active projects yet —{' '}
          <Link href="/projects" className="underline underline-offset-2">
            create one
          </Link>
          .
        </span>
      )}

      {busy && <span className="faint text-[12px]">Saving…</span>}

      {value && !busy && (
        <Link href={`/projects/${value}`} className="text-[12px] underline underline-offset-2">
          Open its P&amp;L
        </Link>
      )}

      {error && (
        <span className="text-[12px]" style={{ color: 'var(--outflow)' }}>
          {error}
        </span>
      )}
    </div>
  );
}
