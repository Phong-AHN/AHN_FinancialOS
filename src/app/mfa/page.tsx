import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getAssurance, mfaPathFor } from '@/lib/auth';
import { safeNextPath } from '@/lib/security';
import { MfaChallenge } from '@/components/MfaForms';
import { MfaShell } from '@/components/MfaShell';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Two-factor sign-in — AHN Financial OS' };

/**
 * The second factor, once it is set up.
 *
 * Outside the `(app)` group on purpose: everything in there requires a
 * finished sign-in, and the person here is exactly the one who has not
 * finished. It still requires the FIRST factor — nobody reaches this page
 * without a password or an emailed link behind them.
 */
export default async function MfaPage(props: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const next = safeNextPath(searchParams.next, '/');

  const step = await getAssurance();
  if (step === 'none') redirect(`/login?next=${encodeURIComponent(next)}`);
  if (step === 'ok') redirect(next);
  if (step === 'enroll') redirect(mfaPathFor('enroll', next)!);

  return (
    <MfaShell title="Two-factor sign-in">
      <MfaChallenge next={next} />
    </MfaShell>
  );
}
