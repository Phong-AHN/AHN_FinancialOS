'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui';

export interface LoginOption {
  id: string;
  email: string;
  /** Already attached to a different person, so offering it would be a lie. */
  takenBy: string | null;
}

/**
 * Attach a login to a person - Spec section 13.
 *
 * Hours are recorded against a person, not a login: a contractor can have one
 * without the other, and most of AHN's will never have a login at all. But
 * without the link, `/timesheet` has nothing to fill in — so this was the one
 * step of self-service time tracking that still needed the SQL console.
 */
export function PersonLogin({
  personId,
  personName,
  currentUserId,
  currentEmail,
  logins,
}: {
  personId: string;
  personName: string;
  currentUserId: string | null;
  currentEmail: string | null;
  logins: LoginOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState(currentUserId ?? '');

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/people/link', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ personId, userId: choice === '' ? null : choice }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!json.ok) {
        setError(json.error ?? 'Could not save that.');
        return;
      }
      setOpen(false);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-left text-[12.5px] underline underline-offset-2"
        style={{ color: currentEmail ? 'inherit' : 'var(--text-muted)' }}
      >
        {currentEmail ?? 'not linked'}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2" style={{ minWidth: 240 }}>
      <select value={choice} onChange={(e) => setChoice(e.target.value)}>
        <option value="">Nobody — {personName} has no login</option>
        {logins.map((l) => (
          <option
            key={l.id}
            value={l.id}
            // One login is one person (migration 0030). Offering a taken one
            // would produce a database error instead of an explanation.
            disabled={l.takenBy !== null && l.id !== currentUserId}
          >
            {l.email}
            {l.takenBy !== null && l.id !== currentUserId ? ` — already ${l.takenBy}` : ''}
          </option>
        ))}
      </select>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || pending}
          className={buttonClass('primary')}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setChoice(currentUserId ?? '');
            setError(null);
          }}
          disabled={busy}
          className={buttonClass('secondary')}
        >
          Cancel
        </button>
      </div>
      {error && (
        <span className="text-[12px]" style={{ color: 'var(--outflow)' }}>
          {error}
        </span>
      )}
    </div>
  );
}
