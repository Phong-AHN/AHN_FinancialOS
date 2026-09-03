import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { crossOriginRefusal } from '@/lib/security';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { recordAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Attach a login to a person - Spec section 13.
 *
 * This is the link `/timesheet` reads to answer "whose hours am I filling in?".
 * Until it existed the only way to set it was the SQL console, which made
 * self-service time tracking self-service for everybody except the first step.
 *
 * The boundary is `p_people_write` (`can_manage_people()`), enforced on the
 * caller's own session client. The unique index from migration 0030 is what
 * makes one login mean one person; this route turns the constraint violation it
 * raises into a sentence.
 */
const LinkSchema = z.object({
  personId: z.string().uuid(),
  /** Null unlinks — somebody leaving keeps their hours and loses the login. */
  userId: z.string().uuid().nullable(),
});

export async function PATCH(request: Request) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  const auth = await requireApiSession({ capability: 'manage_people' });
  if ('response' in auth) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = LinkSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? 'That link is not valid.' },
      { status: 400 },
    );
  }
  const { personId, userId } = parsed.data;

  const db = createSupabaseServerClient();

  const { data: before } = await db
    .from('people')
    .select('id,name,user_id')
    .eq('id', personId)
    .maybeSingle();
  if (!before) return Response.json({ ok: false, error: 'No such person.' }, { status: 404 });
  const prior = before as { id: string; name: string; user_id: string | null };

  const { error } = await db.from('people').update({ user_id: userId }).eq('id', personId);

  if (error) {
    // 23505 is the unique index. Everything else is passed through as-is.
    const message = /duplicate key|unique/i.test(error.message)
      ? 'That login is already attached to somebody else. Unlink it there first — one login is one person, or a timesheet cannot say whose it is.'
      : error.message;
    return Response.json({ ok: false, error: message }, { status: 400 });
  }

  // Who may log hours as whom is a permission, and permissions are audited.
  if (prior.user_id !== userId) {
    const emailOf = async (id: string | null) => {
      if (!id) return null;
      const { data } = await db.from('users').select('email').eq('id', id).maybeSingle();
      return (data as { email: string } | null)?.email ?? id;
    };
    await recordAudit(
      db,
      [
        {
          table_name: 'people',
          record_id: personId,
          field: `login for ${prior.name}`,
          old_value: await emailOf(prior.user_id),
          new_value: await emailOf(userId),
          reason: userId === null ? 'Login unlinked from person' : 'Login linked to person',
        },
      ],
      auth.session.user,
    );
  }

  return Response.json({ ok: true, personId, userId });
}
