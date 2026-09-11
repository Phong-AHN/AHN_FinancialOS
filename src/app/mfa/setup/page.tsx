import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getAssurance, mfaPathFor } from '@/lib/auth';
import { safeNextPath } from '@/lib/security';
import { MfaSetup } from '@/components/MfaForms';
import { MfaShell } from '@/components/MfaShell';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Set up two-factor sign-in — AHN Financial OS' };

/**
 * Mandatory authenticator setup — the first thing anybody without one sees.
 *
 * There is no "skip" and no "later". The database refuses every table to a
 * session without a second factor (migration 0040), so a skip button would
 * only lead to a page full of empty tables.
 *
 * Somebody who already HAS a verified factor is sent to the challenge instead:
 * adding a second authenticator from a one-factor session would let a stolen
 * password enrol the thief's phone. Supabase refuses that too, but the page
 * should not offer it.
 */
export default async function MfaSetupPage(props: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const next = safeNextPath(searchParams.next, '/');

  const step = await getAssurance();
  if (step === 'none') redirect(`/login?next=${encodeURIComponent(next)}`);
  if (step === 'ok') redirect(next);
  if (step === 'challenge') redirect(mfaPathFor('challenge', next)!);

  return (
    <MfaShell title="Set up two-factor sign-in">
      <p className="muted mb-4 text-[13px] leading-relaxed">
        AHN Financial OS holds the company&rsquo;s bank data and can send payroll, so every account
        signs in with a password <strong>and</strong> a code from an authenticator app. This takes
        about a minute and is only done once.
      </p>
      <MfaSetup next={next} />
    </MfaShell>
  );
}
