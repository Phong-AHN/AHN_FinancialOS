import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/LoginForm';
import { AuthHashHandler } from '@/components/AuthHashHandler';
import { getAssurance, getSession, mfaPathFor } from '@/lib/auth';
import { isSupabaseConfigured } from '@/lib/supabase/server';
import { SetupRequired } from '@/components/SetupRequired';
import { safeNextPath } from '@/lib/security';

export const dynamic = 'force-dynamic';

export default async function LoginPage(props: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  // Next 15: a Promise. Rebound under the old name so nothing below changes.
  const searchParams = await props.searchParams;
  if (!isSupabaseConfigured()) return <SetupRequired />;

  // Where to land after signing in. Somebody arriving from the QuickBooks app
  // tile (`/launch`) is heading for Integrations, not the dashboard — losing
  // that on the way through sign-in is how a two-click journey becomes five.
  //
  // Resolved on the server and passed down as a prop rather than read in the
  // browser: `useSearchParams` in a client component drags a Suspense boundary
  // in with it, and the value has to be laundered through `safeNextPath`
  // either way.
  const next = safeNextPath(searchParams.next, '/');

  // Halfway signed in — a password or email link, no second factor yet. The
  // form they would see here is the one they have just completed.
  const mfaPath = mfaPathFor(await getAssurance(), next);
  if (mfaPath) redirect(mfaPath);

  const session = await getSession();
  if (session) redirect(next);

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-[380px]">
        <div className="mb-7 text-center">
          <h1 className="text-[20px] font-semibold tracking-tight">AHN Financial OS</h1>
          <p className="muted mt-1.5 text-[13px]">Every dollar in. Every dollar out.</p>
        </div>

        <div className="card p-6">
          <LoginForm next={next} />
        </div>

        {/* Completes an implicit-flow email link, whose token never reaches the server. */}
        <AuthHashHandler />

        {searchParams.error && (
          <p className="mt-4 text-center text-[12.5px]" style={{ color: 'var(--outflow)' }}>
            {searchParams.error}
          </p>
        )}

        <p className="faint mt-6 text-center text-[11.5px] leading-relaxed">
          Access is restricted to invited accounts. Payroll detail and integration credentials are
          hidden from the viewer role by database policy, not by the interface.
        </p>

        {/* Public, and linked from the one page every visitor reaches. Plaid
            requires a reachable privacy policy before Link may be deployed, and
            Intuit requires both of these before it issues production keys. */}
        <p className="faint mt-3 text-center text-[11.5px]">
          <a href="/privacy" className="underline underline-offset-2">
            Privacy policy
          </a>
          {' · '}
          <a href="/eula" className="underline underline-offset-2">
            Terms of use
          </a>
          {' · '}
          {/* The person least able to reach support from inside the app is the
              one who cannot sign in. */}
          <a href="/support" className="underline underline-offset-2">
            Support
          </a>
        </p>
      </div>
    </div>
  );
}
