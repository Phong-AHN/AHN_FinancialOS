import { redirect } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { getAssurance, getSession, mfaPathFor } from '@/lib/auth';
import { createSupabaseServerClient, isSupabaseConfigured } from '@/lib/supabase/server';
import { SetupRequired } from '@/components/SetupRequired';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Before Supabase is wired up there is no session to check and no data to
  // read, so show the setup checklist instead of a stack trace.
  if (!isSupabaseConfigured()) return <SetupRequired />;

  // Both in flight at once. The badge count does not depend on the session -
  // the same cookie-scoped client answers it, and RLS filters it either way -
  // so awaiting them in sequence just added one Tokyo round trip to the front
  // of every page in the app.
  const supabase = createSupabaseServerClient();
  const [session, { count }] = await Promise.all([
    getSession(),
    supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('reconciliation_status', 'possible_duplicate'),
  ]);

  // Halfway signed in is not signed out. `getSession()` is null for a
  // one-factor session, and sending that person to /login would show them the
  // password form they have just completed — so the second-factor step is
  // checked first. `getAssurance()` is memoised, so this costs no extra call.
  if (!session) redirect(mfaPathFor(await getAssurance()) ?? '/login');

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar role={session.user.role} email={session.email} pendingReview={count ?? 0} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1180px] px-8 py-8">{children}</div>
      </main>
    </div>
  );
}
