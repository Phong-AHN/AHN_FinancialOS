import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { callerKey, crossOriginRefusal, rateLimitRefusal } from '@/lib/security';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { recordAudit, diffForAudit } from '@/lib/audit';
import type { ObligationRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Record a receivable or a payable - Spec sections 17 and 18.
 *
 * These rows are NOT transactions. A transaction is money that moved; an
 * obligation is money that is going to. The separation is what stops a
 * commitment being counted as cash before it leaves the bank.
 */
const CreateSchema = z.object({
  direction: z.enum(['inflow', 'outflow']),
  counterpartyName: z.string().trim().min(1).max(200),
  description: z.string().trim().max(300).nullable().optional(),
  reference: z.string().trim().max(100).nullable().optional(),
  category: z.string().trim().max(60).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  amountMinor: z.number().int().positive(),
  contractedAmountMinor: z.number().int().nonnegative().nullable().optional(),
  currency: z.string().trim().length(3).toUpperCase().default('USD'),
  issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  isRecurring: z.boolean().default(false),
  notes: z.string().trim().max(500).nullable().optional(),
});

export async function POST(request: Request) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  const tooMany = rateLimitRefusal(callerKey(request, 'obligations'), {
    limit: 30,
    windowMs: 60_000,
  });
  if (tooMany) return tooMany;

  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid fields.' },
      { status: 400 },
    );
  }
  const input = parsed.data;

  if (input.issuedOn && input.issuedOn > input.dueOn) {
    return Response.json(
      { ok: false, error: 'An invoice cannot fall due before it was issued.' },
      { status: 400 },
    );
  }

  const db = createSupabaseServerClient();
  const { data, error } = await db
    .from('obligations')
    .insert({
      direction: input.direction,
      counterparty_name: input.counterpartyName,
      description: input.description ?? null,
      reference: input.reference ?? null,
      category: input.category ?? null,
      project_id: input.projectId ?? null,
      amount_minor: input.amountMinor,
      contracted_amount_minor: input.contractedAmountMinor ?? null,
      currency: input.currency,
      issued_on: input.issuedOn ?? null,
      due_on: input.dueOn,
      is_recurring: input.isRecurring,
      notes: input.notes ?? null,
      status: 'open',
    })
    .select('id')
    .single();

  if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });

  const id = (data as { id: string }).id;
  await recordAudit(
    db,
    [
      {
        table_name: 'obligations',
        record_id: id,
        field: 'created',
        old_value: null,
        new_value: `${input.counterpartyName} ${input.amountMinor}`,
        reason: input.direction === 'inflow' ? 'Receivable recorded' : 'Obligation recorded',
      },
    ],
    auth.session.user,
  );

  return Response.json({ ok: true, id });
}

const PatchSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['draft', 'open', 'settled', 'void']),
  /** Required when settling: the payment that closed it. */
  settledTxnId: z.string().uuid().nullable().optional(),
  settledOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

/**
 * Change an obligation's status - usually settling it.
 *
 * Settling is what stops projected cash subtracting a bill that has already
 * been paid, so it goes through the audit trail like any other financial
 * control. The settlement date is required by the database, and defaulted here
 * to today rather than left for Postgres to reject.
 */
export async function PATCH(request: Request) {
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
    return Response.json({ ok: false, error: 'Invalid update.' }, { status: 400 });
  }
  const input = parsed.data;

  const db = createSupabaseServerClient();
  const { data: before } = await db
    .from('obligations')
    .select('*')
    .eq('id', input.id)
    .maybeSingle();

  if (!before) {
    return Response.json({ ok: false, error: 'No such obligation.' }, { status: 404 });
  }

  const settling = input.status === 'settled';
  const patch = {
    status: input.status,
    // The check constraint requires a date on a settled row and forbids one
    // otherwise. Enforcing it here too turns a Postgres constraint error into
    // a sentence.
    settled_on: settling ? (input.settledOn ?? new Date().toISOString().slice(0, 10)) : null,
    settled_txn_id: settling ? (input.settledTxnId ?? null) : null,
  };

  const { error } = await db.from('obligations').update(patch).eq('id', input.id);
  if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });

  const entries = diffForAudit(
    'obligations',
    input.id,
    before as unknown as Record<string, unknown>,
    patch,
    settling ? 'Obligation settled' : `Obligation marked ${input.status}`,
  );
  if (entries.length) await recordAudit(db, entries, auth.session.user);

  return Response.json({ ok: true });
}
