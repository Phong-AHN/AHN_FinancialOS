'use client';

import { useState } from 'react';
import { buttonClass } from '@/components/ui';

/**
 * The lost-phone button, for somebody else's account.
 *
 * Two deliberate frictions, because this is the one control that can hand an
 * account to whoever asks loudest:
 *
 *   1. A confirmation naming the person, so a mis-click on the wrong row in a
 *      list of staff does not silently remove someone's second factor.
 *   2. The confirmation says to verify who is asking. Resetting on the strength
 *      of a chat message saying "hi it's me, new phone" is how an attacker who
 *      already has a password gets past two-factor.
 *
 * It does not switch two-factor off: the account lands on the enrolment screen
 * and can read nothing until it has enrolled again.
 */
export function ResetMfaButton({ userId, email }: { userId: string; email: string }) {
  const [state, setState] = useState<'idle' | 'confirming' | 'working'>('idle');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const reset = async () => {
    setState('working');
    setResult(null);
    try {
      const res = await fetch(`/api/people/${userId}/reset-mfa`, { method: 'POST' });
      const json = (await res.json()) as { ok: boolean; message?: string; error?: string };
      setResult({ ok: json.ok, text: json.message ?? json.error ?? 'Could not reset it.' });
    } catch {
      setResult({ ok: false, text: 'Could not reach the server.' });
    } finally {
      setState('idle');
    }
  };

  if (state === 'confirming') {
    return (
      <div className="mt-2">
        <p className="text-[12.5px]">
          Remove the authenticator for <strong>{email}</strong>? They will set up a new one at their
          next sign-in. Confirm by voice or in person that it is really them before you do this.
        </p>
        <div className="mt-2 flex gap-2">
          <button type="button" className={buttonClass('danger')} onClick={reset}>
            Remove it
          </button>
          <button type="button" className={buttonClass()} onClick={() => setState('idle')}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        className={buttonClass()}
        onClick={() => setState('confirming')}
        disabled={state === 'working'}
      >
        {state === 'working' ? 'Removing…' : 'Reset authenticator'}
      </button>
      {result && (
        <p className={`mt-2 text-[12.5px] ${result.ok ? 'muted' : ''}`} role="status">
          {result.text}
        </p>
      )}
    </div>
  );
}
