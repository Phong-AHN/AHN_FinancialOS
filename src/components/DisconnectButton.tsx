'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui';

/**
 * Disconnect one provider connection.
 *
 * TWO CLICKS, NOT A `confirm()`. Disconnecting revokes the grant at the
 * provider, and reconnecting means the full OAuth round trip again — not a
 * disaster, but not something to do by mis-clicking next to "Sync". The second
 * click is a different button in a different place, so a double-click on the
 * first cannot land on it.
 *
 * No permission logic here. The route requires `move_money` and the database
 * enforces it; this component only renders the control.
 */
export function DisconnectButton({
  integrationId,
  label,
}: {
  integrationId: string;
  label: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/integrations/${integrationId}`, { method: 'DELETE' });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!json.ok) {
        setError(json.error ?? 'Could not disconnect.');
        setArmed(false);
        return;
      }
      startTransition(() => router.refresh());
      setArmed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {armed ? (
        <>
          <span className="text-[12px]">Disconnect {label}?</span>
          <button
            type="button"
            disabled={busy || pending}
            className={buttonClass('danger')}
            onClick={disconnect}
          >
            {busy ? 'Disconnecting…' : 'Yes, revoke access'}
          </button>
          <button
            type="button"
            disabled={busy || pending}
            className={buttonClass('secondary')}
            onClick={() => setArmed(false)}
          >
            Keep it
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={busy || pending}
          className={buttonClass('secondary')}
          onClick={() => setArmed(true)}
        >
          Disconnect
        </button>
      )}

      {error && (
        <span className="text-[12px]" style={{ color: 'var(--outflow)' }}>
          {error}
        </span>
      )}
    </span>
  );
}
