import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { crossOriginRefusal } from '@/lib/security';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { updateWithAudit } from '@/lib/audit';
import type { Transaction } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Manual correction of a transaction - Spec section 3, audited per section 24.
 *
 * Only the interpretive fields are editable. Amount, date, direction, account
 * and the source key are NOT: those are what the bank or the ledger actually
 * reported, and letting them be edited here would break the promise that every
 * dollar traces back to its source. A wrong amount is a source problem, fixed
 * in QuickBooks or by re-importing.
 */
const PatchSchema = z.object({
  category: z.string().max(80).nullable().optional(),
  subcategory: z.string().max(80).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  is_internal_transfer: z.boolean().optional(),
  is_subscription: z.boolean().optional(),
  is_recurring: z.boolean().optional(),
  reconciliation_status: z
    .enum(['unreconciled', 'matched', 'possible_duplicate', 'duplicate_ignored', 'reconciled'])
    .optional(),
  reason: z.string().max(500).nullable().optional(),
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
    return Response.json(
      { error: `Invalid fields: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}` },
      { status: 400 },
    );
  }

  const { reason, ...patch } = parsed.data;
  if (Object.keys(patch).length === 0) {
    return Response.json({ error: 'Nothing to update.' }, { status: 400 });
  }

  const supabase = createSupabaseServerClient();

  try {
    const { after, audited } = await updateWithAudit<Transaction>(supabase, {
      table: 'transactions',
      id: params.id,
      patch: patch as Partial<Transaction>,
      user: auth.session.user,
      reason: reason ?? null,
    });

    return Response.json({ ok: true, audited, transaction: after });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Update failed.' },
      { status: 400 },
    );
  }
}
