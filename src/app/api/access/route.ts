import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { crossOriginRefusal } from '@/lib/security';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { recordAudit } from '@/lib/audit';
import { ROLE_LABELS } from '@/lib/capabilities';
import type { UserRole } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Change somebody's role, or link their Slack account - Spec section 23.
 *
 * WHERE THE BOUNDARY IS. Not here. This route runs on the caller's own session
 * client, so Row Level Security decides whether the update lands, and migration
 * 0028's trigger decides whether it is allowed to mean what it says — no
 * self-promotion, no demoting the last owner, no re-pointing `auth_id` at a
 * different login. Using the service role here would have made these few lines
 * the only thing between an employee and the owner role.
 *
 * What this route adds is the audit entry and a readable error. The database
 * would refuse the same things with this file deleted.
 */
const ROLES = [
  'owner',
  'cfo',
  'accountant',
  'department_lead',
  'project_manager',
  'employee',
  'viewer',
] as const;

const PatchSchema = z
  .object({
    userId: z.string().uuid(),
    role: z.enum(ROLES).optional(),
    /**
     * A Slack member id, or null to unlink.
     *
     * Shape-checked because the failure is silent otherwise: an email or a
     * display name pasted here stores fine and then simply never matches a
     * slash command, leaving somebody refused with no clue why. Slack ids start
     * U (a person) or W (an Enterprise Grid person) and are uppercase.
     */
    slackUserId: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[UW][A-Z0-9]{6,}$/, 'A Slack member id looks like U01ABC2DEF — copy it from the profile menu.')
      .nullable()
      .optional(),
  })
  .refine((v) => v.role !== undefined || v.slackUserId !== undefined, {
    message: 'Nothing to change.',
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

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? 'That change is not valid.' },
      { status: 400 },
    );
  }

  const { userId, role, slackUserId } = parsed.data;
  const db = createSupabaseServerClient();

  // Read first, so the audit entry can say what it changed FROM. Under RLS this
  // returns nothing unless the caller may see the row at all.
  const { data: before } = await db
    .from('users')
    .select('id,email,role,slack_user_id')
    .eq('id', userId)
    .maybeSingle();

  if (!before) {
    return Response.json({ ok: false, error: 'No such user.' }, { status: 404 });
  }
  const prior = before as { id: string; email: string; role: UserRole; slack_user_id: string | null };

  const patch: Record<string, unknown> = {};
  if (role !== undefined) patch.role = role;
  if (slackUserId !== undefined) patch.slack_user_id = slackUserId;

  const { error } = await db.from('users').update(patch).eq('id', userId);

  if (error) {
    // The trigger's messages are written to be read by a person, so they are
    // passed through rather than replaced with something vaguer.
    return Response.json({ ok: false, error: error.message }, { status: 400 });
  }

  // A permission change is the most audit-worthy event in the system: it is the
  // one edit that changes what every future edit is allowed to be.
  const entries = [];
  if (role !== undefined && role !== prior.role) {
    entries.push({
      table_name: 'users',
      record_id: userId,
      field: `role of ${prior.email}`,
      old_value: ROLE_LABELS[prior.role] ?? prior.role,
      new_value: ROLE_LABELS[role] ?? role,
      reason: 'Role changed',
    });
  }
  if (slackUserId !== undefined && slackUserId !== prior.slack_user_id) {
    entries.push({
      table_name: 'users',
      record_id: userId,
      field: `Slack account of ${prior.email}`,
      old_value: prior.slack_user_id,
      new_value: slackUserId,
      reason: slackUserId === null ? 'Slack account unlinked' : 'Slack account linked',
    });
  }
  if (entries.length > 0) await recordAudit(db, entries, auth.session.user);

  return Response.json({ ok: true, userId, role: role ?? prior.role });
}
