/**
 * Session and role helpers - Spec section 23, MVP Plan Day 7.
 *
 * Week 1 has two roles: owner (full access) and viewer (read-only, payroll
 * detail hidden). RLS is the real enforcement boundary; these helpers exist so
 * the UI can fail early with a readable message instead of rendering a page
 * that would come back empty.
 */

import { redirect } from 'next/navigation';
import { createSupabaseServerClient, isSupabaseConfigured } from '@/lib/supabase/server';
import type { AppUser } from '@/lib/types';

export interface Session {
  authId: string;
  email: string;
  user: AppUser;
}

/** Current session, or null when signed out / not yet provisioned. */
export async function getSession(): Promise<Session | null> {
  // No database configured means nobody can be signed in. Returning null here
  // makes every guarded route answer 401/redirect rather than throwing a 500 -
  // an unconfigured deployment should look locked, not broken.
  if (!isSupabaseConfigured()) return null;

  const supabase = createSupabaseServerClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser?.email) return null;

  const { data: appUser } = await supabase
    .from('users')
    .select('*')
    .eq('auth_id', authUser.id)
    .maybeSingle();

  if (appUser) {
    return { authId: authUser.id, email: authUser.email, user: appUser as AppUser };
  }

  // The auth account exists but has no `users` row yet - it was invited through
  // Supabase Auth directly. Link it by email if a row was pre-created for them.
  const { data: byEmail } = await supabase
    .from('users')
    .select('*')
    .eq('email', authUser.email)
    .maybeSingle();

  if (byEmail) {
    await supabase.from('users').update({ auth_id: authUser.id }).eq('id', (byEmail as AppUser).id);
    return {
      authId: authUser.id,
      email: authUser.email,
      user: { ...(byEmail as AppUser), auth_id: authUser.id },
    };
  }

  return null;
}

/** For pages: bounce to login when signed out. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

/** For pages that write. Viewers get a plain refusal, not a broken screen. */
export async function requireOwner(): Promise<Session> {
  const session = await requireSession();
  if (session.user.role !== 'owner') redirect('/?denied=owner-only');
  return session;
}

export function isOwner(session: Session | null): boolean {
  return session?.user.role === 'owner';
}

/** For route handlers: a 401/403 instead of a redirect. */
export async function requireApiSession(
  options: { ownerOnly?: boolean } = {},
): Promise<{ session: Session } | { response: Response }> {
  const session = await getSession();
  if (!session) {
    return {
      response: Response.json({ error: 'Not signed in.' }, { status: 401 }),
    };
  }
  if (options.ownerOnly && session.user.role !== 'owner') {
    return {
      response: Response.json(
        { error: 'This action is restricted to the owner role.' },
        { status: 403 },
      ),
    };
  }
  return { session };
}
