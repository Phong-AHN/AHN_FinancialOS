'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui';

declare global {
  interface Window {
    Plaid?: {
      create(config: {
        token: string;
        onSuccess: (publicToken: string, metadata: unknown) => void;
        onExit: (err: unknown) => void;
      }): { open: () => void };
    };
  }
}

const PLAID_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

/**
 * Plaid Link - MVP Plan Day 3.
 *
 * Link is loaded from Plaid CDN on demand rather than bundled: the public
 * token exchange must happen inside Plaid own iframe, and bank credentials
 * must never touch this application (spec section 25: no storage of raw banking
 * passwords). The browser sends a short-lived public token; the server swaps it
 * for an access token and encrypts that before storing it.
 */
export function PlaidLinkButton({ ready }: { ready: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadScript(): Promise<void> {
    if (window.Plaid) return;
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = PLAID_SCRIPT;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Could not load Plaid Link.'));
      document.head.appendChild(script);
    });
  }

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/integrations/plaid/link-token', { method: 'POST' });
      const json = (await res.json()) as { linkToken?: string; error?: string };
      if (!res.ok || !json.linkToken) throw new Error(json.error ?? 'Could not start Plaid Link.');

      await loadScript();
      if (!window.Plaid) throw new Error('Plaid Link failed to initialise.');

      const handler = window.Plaid.create({
        token: json.linkToken,
        onSuccess: async (publicToken) => {
          setBusy(true);
          try {
            const exchange = await fetch('/api/integrations/plaid/exchange', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ publicToken }),
            });
            const result = (await exchange.json()) as { ok?: boolean; error?: string };
            if (!exchange.ok || !result.ok) {
              setError(result.error ?? 'Could not save the connection.');
            } else {
              router.push('/integrations?connected=Plaid');
              router.refresh();
            }
          } finally {
            setBusy(false);
          }
        },
        onExit: (err) => {
          setBusy(false);
          if (err) setError('Plaid Link closed before the connection finished.');
        },
      });
      handler.open();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start Plaid Link.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-right">
      <button
        type="button"
        onClick={connect}
        disabled={!ready || busy}
        className={buttonClass(ready ? 'primary' : 'secondary')}
      >
        {busy ? 'Opening…' : 'Connect a bank'}
      </button>
      {error && (
        <p className="mt-1.5 max-w-[240px] text-[11.5px]" style={{ color: 'var(--outflow)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
