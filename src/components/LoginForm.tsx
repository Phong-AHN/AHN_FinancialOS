'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { buttonClass } from '@/components/ui';

type Mode = 'password' | 'magic';

/**
 * Sign-in - MVP Plan Day 1 (Supabase Auth, no hand-rolled auth).
 *
 * Two routes in, because a CEO checking cash from a phone should not have to
 * remember a password, while a builder running the app locally should not have
 * to wait on an inbox.
 */
export function LoginForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);

    try {
      const supabase = createSupabaseBrowserClient();

      if (mode === 'magic') {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: `${window.location.origin}/api/auth/callback` },
        });
        setMessage(
          error
            ? { ok: false, text: error.message }
            : { ok: true, text: 'Check your inbox for the sign-in link.' },
        );
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          setMessage({ ok: false, text: error.message });
        } else {
          router.push('/');
          router.refresh();
        }
      }
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Sign-in failed.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3.5">
      <label className="block">
        <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">Email</span>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@asianhustlenetwork.com"
        />
      </label>

      {mode === 'password' && (
        <label className="block">
          <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">Password</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
      )}

      <button type="submit" disabled={busy} className={`${buttonClass('primary')} w-full`}>
        {busy ? 'Signing in…' : mode === 'magic' ? 'Email me a sign-in link' : 'Sign in'}
      </button>

      <button
        type="button"
        className="faint w-full text-center text-[12px] underline underline-offset-2"
        onClick={() => {
          setMode(mode === 'password' ? 'magic' : 'password');
          setMessage(null);
        }}
      >
        {mode === 'password' ? 'Use a magic link instead' : 'Use a password instead'}
      </button>

      {message && (
        <p
          className="text-center text-[12.5px]"
          style={{ color: message.ok ? 'var(--inflow)' : 'var(--outflow)' }}
        >
          {message.text}
        </p>
      )}
    </form>
  );
}
