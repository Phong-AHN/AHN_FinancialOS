'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui';

/**
 * Stripe needs no OAuth dance - the secret key in the environment is the
 * credential. This just records the integration row so the cron picks it up.
 */
export function EnableStripeButton({
  ready,
  alreadyEnabled,
}: {
  ready: boolean;
  alreadyEnabled: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/integrations/stripe/enable', { method: 'POST' });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? 'Could not enable Stripe.');
      } else {
        router.push('/integrations?connected=Stripe');
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not enable Stripe.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-right">
      <button
        type="button"
        onClick={enable}
        disabled={!ready || busy}
        className={buttonClass(ready && !alreadyEnabled ? 'primary' : 'secondary')}
      >
        {busy ? 'Enabling…' : alreadyEnabled ? 'Re-check Stripe' : 'Enable Stripe'}
      </button>
      {error && (
        <p className="mt-1.5 max-w-[240px] text-[11.5px]" style={{ color: 'var(--outflow)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
