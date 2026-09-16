'use client';

import { useCallback, useEffect, useState } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { buttonClass } from '@/components/ui';

/**
 * The two things a person needs to be able to do to their own sign-in without
 * asking anybody: change the password, and move the authenticator to a new
 * phone.
 *
 * ORDER IS THE WHOLE DESIGN HERE. Every page behind the login is refused to a
 * session that has not passed a second factor — by row-level security in the
 * database, not by routing — so an account with its factor deleted and nothing
 * enrolled in its place is an account that can see nothing. The replacement is
 * therefore enrolled and VERIFIED FIRST, and only then is the old factor
 * removed. A failure at any point leaves the old authenticator working.
 *
 * The factor secret never touches this application's server: enrolment talks to
 * Supabase Auth straight from the browser.
 */

function friendly(message: string): string {
  if (/invalid.*(totp|code)/i.test(message)) return 'That code is not right. Codes change every 30 seconds — try the current one.';
  if (/expired/i.test(message)) return 'That code has expired. Enter the one your app is showing now.';
  if (/too many|rate/i.test(message)) return 'Too many attempts. Wait a minute and try again.';
  if (/invalid login credentials/i.test(message)) return 'That is not your current password.';
  if (/should be different|same as the old/i.test(message)) return 'The new password has to be different from the old one.';
  return message;
}

function Note({ tone, children }: { tone: 'ok' | 'bad'; children: React.ReactNode }) {
  return (
    <p
      className={`mt-3 rounded-md border px-3 py-2 text-[12.5px] ${
        tone === 'ok'
          ? 'border-[var(--inflow-line,var(--line))] text-[var(--inflow,inherit)]'
          : 'border-[var(--outflow-line,var(--line))] text-[var(--outflow,inherit)]'
      }`}
      role={tone === 'bad' ? 'alert' : 'status'}
    >
      {children}
    </p>
  );
}

// ─── Password ───────────────────────────────────────────────────────────────

/**
 * Twelve characters, and not built out of the address you sign in with.
 *
 * Deliberately not a character-class rule ("one capital, one symbol"): those
 * produce Ahnmedia123@, which is a dictionary word, a year and the symbol
 * everybody picks. Length is what actually costs an attacker time.
 */
function passwordProblem(password: string, email: string): string | null {
  if (password.length < 12) return 'Use at least 12 characters. Length matters more than symbols.';
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  const domain = email.split('@')[1]?.split('.')[0]?.toLowerCase() ?? '';
  const lowered = password.toLowerCase();
  if (local.length > 3 && lowered.includes(local)) return 'Do not build the password out of your email address.';
  if (domain.length > 3 && lowered.includes(domain)) return 'Do not build the password out of the company name.';
  if (/^(.)\1+$/.test(password)) return 'That is one character repeated.';
  return null;
}

function PasswordSection({ email }: { email: string }) {
  const supabase = createSupabaseBrowserClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setNote(null);

    if (next !== again) {
      setNote({ tone: 'bad', text: 'The two new passwords do not match.' });
      return;
    }
    const problem = passwordProblem(next, email);
    if (problem) {
      setNote({ tone: 'bad', text: problem });
      return;
    }

    setBusy(true);
    try {
      // Prove the current password before changing it. A session left open on
      // an unlocked laptop should not be enough to take the account over.
      const { error: reauth } = await supabase.auth.signInWithPassword({ email, password: current });
      if (reauth) throw reauth;

      const { error } = await supabase.auth.updateUser({ password: next });
      if (error) throw error;

      setCurrent('');
      setNext('');
      setAgain('');
      setNote({
        tone: 'ok',
        text: 'Password changed. Other devices stay signed in — sign out everywhere from your Supabase account if a device is lost.',
      });
    } catch (err) {
      setNote({ tone: 'bad', text: friendly(err instanceof Error ? err.message : 'Could not change the password.') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block">
        <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">Current password</span>
        <input
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          required
          disabled={busy}
        />
      </label>
      <label className="block">
        <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">New password</span>
        <input
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          required
          disabled={busy}
        />
      </label>
      <label className="block">
        <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">New password again</span>
        <input
          type="password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          autoComplete="new-password"
          required
          disabled={busy}
        />
      </label>
      <button type="submit" className={buttonClass('primary')} disabled={busy || !current || !next}>
        {busy ? 'Changing…' : 'Change password'}
      </button>
      <p className="faint text-[12px]">
        At least 12 characters, and not made of your email address or the company name. A password
        manager generating a random one is better than any rule.
      </p>
      {note && <Note tone={note.tone}>{note.text}</Note>}
    </form>
  );
}

// ─── Authenticator ──────────────────────────────────────────────────────────

interface Factor {
  id: string;
  friendly_name?: string | null;
  created_at?: string;
}

function AuthenticatorSection() {
  const supabase = createSupabaseBrowserClient();
  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [enrolling, setEnrolling] = useState<{ factorId: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) {
      setNote({ tone: 'bad', text: friendly(error.message) });
      setFactors([]);
      return;
    }
    setFactors((data?.totp ?? []) as Factor[]);
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  const startReplacement = async () => {
    setBusy(true);
    setNote(null);
    try {
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: `My Cash Pilot · ${new Date().toISOString().slice(0, 16)}`,
      });
      if (error) throw error;
      setEnrolling({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    } catch (err) {
      setNote({ tone: 'bad', text: friendly(err instanceof Error ? err.message : 'Could not start the setup.') });
    } finally {
      setBusy(false);
    }
  };

  const cancelReplacement = async () => {
    if (!enrolling) return;
    setBusy(true);
    // Remove the half-finished factor rather than leaving an unverified one behind.
    await supabase.auth.mfa.unenroll({ factorId: enrolling.factorId }).catch(() => undefined);
    setEnrolling(null);
    setCode('');
    setBusy(false);
    await load();
  };

  const confirmReplacement = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!enrolling) return;
    setBusy(true);
    setNote(null);
    try {
      // 1. The new authenticator must work…
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrolling.factorId, code });
      if (error) throw error;

      // 2. …before the old ones are removed. Never the other way round.
      const old = (factors ?? []).filter((f) => f.id !== enrolling.factorId);
      let removed = 0;
      for (const factor of old) {
        const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
        if (!unenrollError) removed++;
      }

      setEnrolling(null);
      setCode('');
      await load();
      setNote({
        tone: 'ok',
        text:
          removed > 0
            ? `New authenticator in use. The previous one no longer works — delete it from your old phone.`
            : 'New authenticator in use.',
      });
    } catch (err) {
      setNote({ tone: 'bad', text: friendly(err instanceof Error ? err.message : 'Could not verify that code.') });
    } finally {
      setBusy(false);
    }
  };

  if (factors === null) return <p className="muted text-[13px]">Checking your authenticator…</p>;

  if (enrolling) {
    return (
      <form onSubmit={confirmReplacement} className="space-y-3">
        <p className="text-[13px]">
          1. Open your authenticator app on the new phone and scan this code.
        </p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={enrolling.qr}
          alt="QR code to add My Cash Pilot to your authenticator app"
          className="mx-auto block h-44 w-44"
        />
        <details className="text-[12.5px]">
          <summary className="faint cursor-pointer">Cannot scan? Enter this key instead</summary>
          <code className="mt-1 block break-all text-[12px]">{enrolling.secret}</code>
        </details>
        <p className="text-[13px]">2. Enter the six-digit code it shows.</p>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          aria-label="Six-digit code from your authenticator app"
          className="tabular w-full text-center text-[20px] tracking-[0.3em]"
          disabled={busy}
          autoFocus
        />
        <div className="flex gap-2">
          <button type="submit" className={buttonClass('primary')} disabled={busy || code.length !== 6}>
            {busy ? 'Checking…' : 'Use this authenticator'}
          </button>
          <button type="button" className={buttonClass()} onClick={cancelReplacement} disabled={busy}>
            Cancel
          </button>
        </div>
        <p className="faint text-[12px]">
          Your current authenticator keeps working until this one is confirmed.
        </p>
        {note && <Note tone={note.tone}>{note.text}</Note>}
      </form>
    );
  }

  return (
    <div>
      {factors.length === 0 ? (
        <p className="text-[13px]">No authenticator is enrolled. You will be asked to set one up at your next sign-in.</p>
      ) : (
        <ul className="mb-3 space-y-1">
          {factors.map((f) => (
            <li key={f.id} className="text-[13px]">
              <span className="font-medium">{f.friendly_name || 'Authenticator app'}</span>
              {f.created_at && (
                <span className="muted"> — added {new Date(f.created_at).toISOString().slice(0, 10)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className={buttonClass()} onClick={startReplacement} disabled={busy}>
        {factors.length === 0 ? 'Set up an authenticator' : 'Move to a new phone'}
      </button>
      <p className="faint mt-2 text-[12px]">
        Two-factor sign-in cannot be switched off: the database refuses every row to a session that
        has not passed it. Changing phones replaces the authenticator instead — the new one is set
        up and tested before the old one stops working.
      </p>
      {note && <Note tone={note.tone}>{note.text}</Note>}
    </div>
  );
}

export function SecuritySettings({ email }: { email: string }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="card p-4">
        <h2 className="mb-1 text-[14px] font-semibold">Password</h2>
        <p className="muted mb-3 text-[12.5px]">Signed in as {email}.</p>
        <PasswordSection email={email} />
      </section>
      <section className="card p-4">
        <h2 className="mb-1 text-[14px] font-semibold">Authenticator app</h2>
        <p className="muted mb-3 text-[12.5px]">The second factor asked for at every sign-in.</p>
        <AuthenticatorSection />
      </section>
    </div>
  );
}
