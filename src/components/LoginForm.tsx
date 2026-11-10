'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { buttonClass } from '@/components/ui';
import { magicLinkSent, signInMessage } from '@/lib/auth-messages';

type Mode = 'password' | 'magic';

/**
 * Sign-in - MVP Plan Day 1 (Supabase Auth, no hand-rolled auth).
 *
 * Two routes in, because a CEO checking cash from a phone should not have to
 * remember a password, while a builder running the app locally should not have
 * to wait on an inbox.
 */
export function LoginForm({ next = '/' }: { next?: string }) {
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
          options: {
            // Access is by invitation. Left at its default, this call CREATES
            // an account for any address typed into the box and emails it a
            // link - a way for a stranger to make the company's portal send
            // mail on their behalf, and a pile of accounts nobody granted.
            shouldCreateUser: false,
            // The callback launders `next` through `safeNextPath` before it
            // redirects, so a tampered link cannot land somebody off-site.
            emailRedirectTo: `${window.location.origin}/api/auth/callback?next=${encodeURIComponent(next)}`,
          },
        });
        // An address with no account reports success too: see the second rule
        // in auth-messages.ts. Only a real failure - a rate limit, a network
        // error - says anything else.
        const problem = error ? signInMessage(error.message) : null;
        setMessage(problem ? { ok: false, text: problem.text } : { ok: true, text: magicLinkSent(email) });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          setMessage({ ok: false, text: signInMessage(error.message)?.text ?? 'Sign-in failed.' });
          // Clear the password, keep the email: the next attempt is almost
          // always the same address with a different password.
          setPassword('');
        } else {
          router.push(next);
          router.refresh();
        }
      }
    } catch (err) {
      const problem = signInMessage(err instanceof Error ? err.message : null);
      setMessage({ ok: false, text: problem?.text ?? 'Sign-in failed. Try again.' });
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
          role={message.ok ? 'status' : 'alert'}
          className="text-center text-[12.5px] leading-relaxed"
          style={{ color: message.ok ? 'var(--inflow)' : 'var(--outflow)' }}
        >
          {message.text}
        </p>
      )}
    </form>
  );
}
