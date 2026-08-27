import { redirect } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { getSession } from '@/lib/auth';
import { createSupabaseServerClient, isSupabaseConfigured } from '@/lib/supabase/server';
import { SetupRequired } from '@/components/SetupRequired';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Before Supabase is wired up there is no session to check and no data to
  // read, so show the setup checklist instead of a stack trace.
  if (!isSupabaseConfigured()) return <SetupRequired />;

  const session = await getSession();
  if (!session) redirect('/login');

  const supabase = createSupabaseServerClient();
  const { count } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('reconciliation_status', 'possible_duplicate');

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar role={session.user.role} email={session.email} pendingReview={count ?? 0} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1180px] px-8 py-8">{children}</div>
      </main>
    </div>
  );
}
