import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/LoginForm';
import { AuthHashHandler } from '@/components/AuthHashHandler';
import { getSession } from '@/lib/auth';
import { isSupabaseConfigured } from '@/lib/supabase/server';
import { SetupRequired } from '@/components/SetupRequired';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  if (!isSupabaseConfigured()) return <SetupRequired />;

  const session = await getSession();
  if (session) redirect('/');

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-[380px]">
        <div className="mb-7 text-center">
          <h1 className="text-[20px] font-semibold tracking-tight">AHN Financial OS</h1>
          <p className="muted mt-1.5 text-[13px]">Every dollar in. Every dollar out.</p>
        </div>

        <div className="card p-6">
          <LoginForm />
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
      </div>
    </div>
  );
}
