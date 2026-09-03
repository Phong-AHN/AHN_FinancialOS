/**
 * Session and role helpers - Spec section 23, MVP Plan Day 7.
 *
 * Week 1 has two roles: owner (full access) and viewer (read-only, payroll
 * detail hidden). RLS is the real enforcement boundary; these helpers exist so
 * the UI can fail early with a readable message instead of rendering a page
 * that would come back empty.
 */

import { cache } from 'react';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient, isSupabaseConfigured } from '@/lib/supabase/server';
import { CAPABILITY_REFUSAL, can, type Capability } from '@/lib/capabilities';
import type { AppUser } from '@/lib/types';

export interface Session {
  authId: string;
  email: string;
  user: AppUser;
}

/**
 * Current session, or null when signed out / not yet provisioned.
 *
 * MEMOISED PER REQUEST. Without this it ran twice on every page load - once in
 * the layout to pick the navigation, once in the page to guard it - and each
 * run costs two sequential round trips to Tokyo: `auth.getUser()` validates the
 * token against the Auth server rather than decoding it locally, then the
 * `users` row is fetched for the role. Measured at ~159ms and ~158ms, so the
 * duplicate pass alone was adding about a third of a second to every click.
 *
 * `cache()` is React's per-request memo, so a second caller in the same render
 * gets the first result. It does NOT cache across requests: a sign-out or a
 * role change is picked up by the very next navigation.
 */
export const getSession = cache(async function getSession(): Promise<Session | null> {
  // No database configured means nobody can be signed in. Returning null here
  // makes every guarded route answer 401/redirect rather than throwing a 500 -
  // an unconfigured deployment should look locked, not broken.
  if (!isSupabaseConfigured()) return null;

  const supabase = createSupabaseServerClient();

  // The cookie already carries the user id. Reading it locally costs nothing
  // and lets the `users` lookup start at the same moment as the verification,
  // instead of waiting a full Tokyo round trip for an id it already had.
  //
  // Nothing is trusted on the strength of the local read: `getUser()` runs in
  // the same breath, verified against the Auth server, and the two ids are
  // compared below. A tampered cookie fails that comparison and the request is
  // treated as signed out.
  const { data: local } = await supabase.auth.getSession();
  const claimedId = local.session?.user.id ?? null;

  // No cookie at all means no session, and no reason to ask Tokyo about it.
  if (!claimedId) return null;

  const [verified, byAuthId] = await Promise.all([
    supabase.auth.getUser(),
    supabase.from('users').select('*').eq('auth_id', claimedId).maybeSingle(),
  ]);

  const authUser = verified.data.user;
  if (!authUser?.email) return null;

  // The optimistic lookup is only usable if the token really did belong to the
  // user it claimed. Otherwise fall through and look the verified id up.
  const appUser =
    authUser.id === claimedId
      ? byAuthId.data
      : (
          await supabase.from('users').select('*').eq('auth_id', authUser.id).maybeSingle()
        ).data;

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
});

/** For pages: bounce to login when signed out. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

/**
 * For pages that write.
 *
 * Named for the capability rather than the role, because there are seven roles
 * now and a page that asks "is this the owner?" locks the CFO out of their own
 * job. The database enforces the same thing through RLS; this exists so the
 * refusal is a redirect rather than an empty screen.
 */
export async function requireCapability(capability: Capability): Promise<Session> {
  const session = await requireSession();
  if (!can(session.user.role, capability)) redirect(`/?denied=${capability}`);
  return session;
}

/** Kept for the pages that genuinely mean "may change money". */
export async function requireOwner(): Promise<Session> {
  return requireCapability('move_money');
}

export function isOwner(session: Session | null): boolean {
  return session?.user.role === 'owner';
}

/** The question almost every page actually wants to ask. */
export function sessionCan(session: Session | null, capability: Capability): boolean {
  return can(session?.user.role, capability);
}

/** For route handlers: a 401/403 instead of a redirect. */
export async function requireApiSession(
  options: { ownerOnly?: boolean; capability?: Capability } = {},
): Promise<{ session: Session } | { response: Response }> {
  const session = await getSession();
  if (!session) {
    return {
      response: Response.json({ error: 'Not signed in.' }, { status: 401 }),
    };
  }
  // `ownerOnly` predates the seven roles and now means "may change money" —
  // otherwise every route written before §23 would lock out the CFO, whose job
  // it is. A route can name a narrower capability instead.
  const needed: Capability | null = options.capability ?? (options.ownerOnly ? 'move_money' : null);
  if (needed && !can(session.user.role, needed)) {
    return {
      response: Response.json({ error: CAPABILITY_REFUSAL[needed] }, { status: 403 }),
    };
  }
  return { session };
}
