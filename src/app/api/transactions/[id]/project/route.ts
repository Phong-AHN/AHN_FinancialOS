import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { crossOriginRefusal } from '@/lib/security';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { updateWithAudit } from '@/lib/audit';
import type { Transaction } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Attribute a transaction to a project, or take it off one - Spec section 12.
 *
 * Attribution is a financial control: it decides which project shows a profit,
 * so it goes through the audit trail like any other hand edit. `null` detaches,
 * which is a real and common answer — most overhead belongs to no project, and
 * forcing everything onto one would spread rent across client work and make
 * every project look worse than it is.
 */
const PatchSchema = z.object({
  projectId: z.string().uuid().nullable(),
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
    return Response.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'Invalid project id.' }, { status: 400 });
  }

  const db = createSupabaseServerClient();

  // Reject an unknown project rather than writing a dangling id. The column has
  // `on delete set null`, so a bad id would not error at the database — it would
  // simply attribute money to nothing and never say so.
  if (parsed.data.projectId) {
    const { data: project } = await db
      .from('projects')
      .select('id')
      .eq('id', parsed.data.projectId)
      .maybeSingle();
    if (!project) {
      return Response.json({ ok: false, error: 'That project does not exist.' }, { status: 400 });
    }
  }

  try {
    const { after, audited } = await updateWithAudit<Transaction>(db, {
      table: 'transactions',
      id: params.id,
      patch: { project_id: parsed.data.projectId },
      user: auth.session.user,
      reason: parsed.data.projectId ? 'Attributed to a project' : 'Removed from a project',
    });
    return Response.json({ ok: true, audited, projectId: after.project_id });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'Update failed.' },
      { status: 400 },
    );
  }
}
