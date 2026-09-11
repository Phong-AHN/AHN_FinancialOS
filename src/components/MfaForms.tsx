'use client';

import { useEffect, useRef, useState } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { buttonClass } from '@/components/ui';

/**
 * The two halves of two-factor sign-in: setting up an authenticator, and using
 * it. Both talk to Supabase Auth directly from the browser — the factor secret
 * never passes through this application's server.
 *
 * On success both do a FULL navigation rather than a client-side push. The
 * session cookie has just been upgraded to aal2, and a full load guarantees the
 * server renders the next page with that cookie rather than a cached aal1 one.
 */

function friendly(message: string): string {
  if (/invalid.*(totp|code)/i.test(message)) return 'That code is not right. Codes change every 30 seconds — try the current one.';
  if (/expired/i.test(message)) return 'That code has expired. Enter the one your app is showing now.';
  if (/too many|rate/i.test(message)) return 'Too many attempts. Wait a minute and try again.';
  return message;
}

function CodeInput({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled: boolean }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder="123456"
      aria-label="Six-digit code from your authenticator app"
      disabled={disabled}
      className="tabular w-full text-center text-[20px] tracking-[0.3em]"
      autoFocus
    />
  );
}

function SignOut() {
  return (
    <form action="/api/auth/signout" method="post" className="mt-5 text-center">
      <button type="submit" className="faint text-[12px] underline underline-offset-2">
        Sign out
      </button>
    </form>
  );
}

// ─── Setting up an authenticator ────────────────────────────────────────────

export function MfaSetup({ next }: { next: string }) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; factorId: string; qr: string; secret: string }
    | { kind: 'failed'; message: string }
  >({ kind: 'loading' });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // React runs effects twice in development. Enrolling twice would leave an
  // orphan factor behind, so the enrolment is guarded by a ref.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    void (async () => {
      const supabase = createSupabaseBrowserClient();

      // An abandoned earlier attempt leaves an unverified factor. Clearing them
      // first means a person who closed the tab can simply start again.
      const { data: existing } = await supabase.auth.mfa.listFactors();
      for (const f of existing?.all ?? []) {
        if (f.factor_type === 'totp' && f.status === 'unverified') {
          await supabase.auth.mfa.unenroll({ factorId: f.id });
        }
      }

      const { data, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: `AHN Financial OS · ${new Date().toISOString().slice(0, 16)}`,
      });
      if (enrollError || !data) {
        setState({ kind: 'failed', message: enrollError?.message ?? 'Could not start setup.' });
        return;
      }
      setState({ kind: 'ready', factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    })();
  }, []);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (state.kind !== 'ready') return;
    setBusy(true);
    setError(null);
    const supabase = createSupabaseBrowserClient();
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
      factorId: state.factorId,
      code,
    });
    if (verifyError) {
      setError(friendly(verifyError.message));
      setCode('');
      setBusy(false);
      return;
    }
    window.location.assign(next);
  }

  if (state.kind === 'loading') return <p className="muted text-center text-[13px]">Preparing your setup code…</p>;
  if (state.kind === 'failed')
    return (
      <>
        <p className="text-[13px]" style={{ color: 'var(--outflow)' }}>
          {state.message}
        </p>
        <SignOut />
      </>
    );

  return (
    <form onSubmit={verify}>
      <ol className="muted space-y-2 text-[13px] leading-relaxed">
        <li>
          1. Open an authenticator app — Google Authenticator, Microsoft Authenticator, 1Password,
          Authy or similar.
        </li>
        <li>2. Scan this code with it.</li>
      </ol>

      {/* A data: URI from Supabase. The CSP allows data: images for exactly
          this; the secret never touches this application's server. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={state.qr}
        alt="QR code to add AHN Financial OS to your authenticator app"
        width={184}
        height={184}
        className="mx-auto my-4 rounded-lg bg-white p-2"
      />

      <details className="mb-4 text-[12px]">
        <summary className="faint cursor-pointer">Cannot scan? Enter this key instead</summary>
        <code className="mt-2 block break-all text-[12.5px]">
          {state.secret.replace(/(.{4})/g, '$1 ').trim()}
        </code>
      </details>

      <p className="muted mb-2 text-[13px]">3. Enter the six-digit code the app shows.</p>
      <CodeInput value={code} onChange={setCode} disabled={busy} />

      {error && (
        <p className="mt-3 text-[12.5px]" style={{ color: 'var(--outflow)' }}>
          {error}
        </p>
      )}

      <button type="submit" disabled={busy || code.length !== 6} className={`${buttonClass('primary')} mt-4 w-full`}>
        {busy ? 'Checking…' : 'Turn on two-factor sign-in'}
      </button>
      <SignOut />
    </form>
  );
}

// ─── Using it ───────────────────────────────────────────────────────────────

export function MfaChallenge({ next }: { next: string }) {
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const supabase = createSupabaseBrowserClient();
      const { data } = await supabase.auth.mfa.listFactors();
      const verified = data?.totp?.[0];
      // Arrived here without a factor after all — send them to set one up.
      if (!verified) {
        window.location.assign(`/mfa/setup${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`);
        return;
      }
      setFactorId(verified.id);
    })();
  }, [next]);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setBusy(true);
    setError(null);
    const supabase = createSupabaseBrowserClient();
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    if (verifyError) {
      setError(friendly(verifyError.message));
      setCode('');
      setBusy(false);
      return;
    }
    window.location.assign(next);
  }

  return (
    <form onSubmit={verify}>
      <p className="muted mb-3 text-[13px]">Enter the six-digit code from your authenticator app.</p>
      <CodeInput value={code} onChange={setCode} disabled={busy || !factorId} />
      {error && (
        <p className="mt-3 text-[12.5px]" style={{ color: 'var(--outflow)' }}>
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || !factorId || code.length !== 6}
        className={`${buttonClass('primary')} mt-4 w-full`}
      >
        {busy ? 'Checking…' : 'Verify'}
      </button>
      <p className="faint mt-4 text-center text-[11.5px]">
        Lost your authenticator? <a href="/support" className="underline underline-offset-2">Contact support</a> —
        an administrator can reset it after confirming who you are.
      </p>
      <SignOut />
    </form>
  );
}
