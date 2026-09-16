import { requireApiSession } from '@/lib/auth';
import { callerKey, crossOriginRefusal, rateLimitRefusal } from '@/lib/security';
import { createSupabaseAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { recordAudit } from '@/lib/audit';
import type { AppUser } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Remove someone's authenticator so they can enrol a new one.
 *
 * THE CASE THIS EXISTS FOR: a phone is lost, replaced or wiped. The person can
 * still prove their password but can no longer produce a code, and every page
 * behind the login refuses an aal1 session — by row-level security, not merely
 * by routing. Without this they are locked out permanently, and the sign-in
 * screen's promise that "an administrator can reset it after confirming who you
 * are" is a sentence with no code behind it.
 *
 * WHAT IT IS NOT: a way to switch two-factor off. Deleting the factor does not
 * grant access; it returns the account to the enrolment screen, which is the
 * first thing it will see on the next sign-in. The account cannot read a single
 * row until it has enrolled again.
 *
 * WHO MAY: `manage_people` — the same capability that grants and changes roles.
 * Resetting a factor is exactly as powerful as handing out a role, since both
 * decide who can reach the money.
 *
 * NOT FOR YOURSELF. An owner who still holds a session should rotate their own
 * authenticator on the security page, which enrols the replacement BEFORE the
 * old one is removed. Deleting your own only factor mid-session leaves you at
 * the enrolment screen with nothing to enrol from.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;

  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  const tooMany = rateLimitRefusal(callerKey(request, 'reset-mfa'), { limit: 10, windowMs: 60 * 60_000 });
  if (tooMany) return tooMany;

  const auth = await requireApiSession({ capability: 'manage_people' });
  if ('response' in auth) return auth.response;

  if (!isAdminConfigured()) {
    return Response.json({ ok: false, error: 'Supabase service role is not configured.' }, { status: 503 });
  }

  const db = createSupabaseServerClient();
  const { data, error } = await db.from('users').select('id,email,auth_id,role').eq('id', params.id).maybeSingle();
  if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });
  if (!data) return Response.json({ ok: false, error: 'No such person.' }, { status: 404 });

  const target = data as Pick<AppUser, 'id' | 'email' | 'auth_id' | 'role'>;

  if (target.id === auth.session.user.id) {
    return Response.json(
      {
        ok: false,
        error:
          'This is your own account. Replace your authenticator from the security page instead — it sets up the new one before removing the old, so you are never left without a second factor.',
      },
      { status: 400 },
    );
  }
  if (!target.auth_id) {
    return Response.json(
      { ok: false, error: `${target.email} has no login yet, so there is no authenticator to reset.` },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();
  const { data: listed, error: listError } = await admin.auth.admin.mfa.listFactors({ userId: target.auth_id });
  if (listError) {
    return Response.json({ ok: false, error: `Could not read their factors: ${listError.message}` }, { status: 502 });
  }

  const factors = listed?.factors ?? [];
  if (factors.length === 0) {
    return Response.json({
      ok: true,
      removed: 0,
      message: `${target.email} has no authenticator enrolled. They will be asked to set one up at their next sign-in.`,
    });
  }

  for (const factor of factors) {
    const { error: deleteError } = await admin.auth.admin.mfa.deleteFactor({ id: factor.id, userId: target.auth_id });
    if (deleteError) {
      return Response.json(
        { ok: false, error: `Removed ${factors.indexOf(factor)} of ${factors.length}: ${deleteError.message}` },
        { status: 502 },
      );
    }
  }

  // Written with the admin client: the audit log is append-only to everyone else.
  await recordAudit(
    admin,
    [
      {
        table_name: 'users',
        record_id: target.id,
        field: 'mfa_factor',
        old_value: `${factors.length} enrolled`,
        new_value: 'removed',
        reason: `Authenticator reset by ${auth.session.email} — ${target.email} must enrol a new one at next sign-in`,
      },
    ],
    auth.session.user,
  );

  return Response.json({
    ok: true,
    removed: factors.length,
    message: `Removed ${factors.length} authenticator${factors.length === 1 ? '' : 's'} for ${target.email}. They will be asked to set up a new one at their next sign-in — confirm it is really them before telling them it is done.`,
  });
}
