import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { crossOriginRefusal } from '@/lib/security';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { updateWithAudit } from '@/lib/audit';
import type { AlertRule } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Alert-rule configuration - Spec section 4.
 *
 * Changing who gets paged about money is a financial control, so these edits go
 * through the same audit path as transaction edits: turning off the low-runway
 * alert leaves a record of who did it and when.
 */
const PatchSchema = z.object({
  enabled: z.boolean().optional(),
  channels: z.array(z.enum(['slack', 'email', 'sms', 'in_app'])).max(4).optional(),
  threshold_minor: z.number().int().nonnegative().nullable().optional(),
  threshold_number: z.number().nonnegative().nullable().optional(),
  severity: z.enum(['info', 'warning', 'critical', 'digest']).optional(),
});

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid alert-rule fields.' }, { status: 400 });
  }
  if (Object.keys(parsed.data).length === 0) {
    return Response.json({ error: 'Nothing to update.' }, { status: 400 });
  }

  const supabase = createSupabaseServerClient();

  try {
    const { after, audited } = await updateWithAudit<AlertRule>(supabase, {
      table: 'alert_rules',
      id: params.id,
      patch: parsed.data as Partial<AlertRule>,
      user: auth.session.user,
      reason: 'Alert configuration changed',
    });
    return Response.json({ ok: true, audited, rule: after });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Update failed.' },
      { status: 400 },
    );
  }
}
