import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { callerKey, crossOriginRefusal, rateLimitRefusal } from '@/lib/security';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { recordAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Create or replace a budget - Spec section 19.
 *
 * The scope rules are enforced here as well as by the database constraint,
 * because a 400 that names the problem is more use than a Postgres error that
 * names a constraint.
 */
const BudgetSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    scope: z.enum(['company', 'business_unit', 'client', 'project', 'category', 'total']),
    scopeId: z.string().uuid().nullable().optional(),
    scopeKey: z.string().trim().max(100).nullable().optional(),
    period: z.enum(['month', 'quarter', 'year']).default('month'),
    startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    amountMinor: z.number().int().nonnegative(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .refine(
    (v) =>
      v.scope === 'total'
        ? !v.scopeId && !v.scopeKey
        : v.scope === 'category'
          ? Boolean(v.scopeKey) && !v.scopeId
          : Boolean(v.scopeId) && !v.scopeKey,
    {
      message:
        'A company, unit, client or project budget needs its target id; a category budget needs the category name; a total budget takes neither.',
    },
  );

export async function POST(request: Request) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  const tooMany = rateLimitRefusal(callerKey(request, 'budgets'), {
    limit: 20,
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

  const parsed = BudgetSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid budget.' },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // A period budget has to start on a period boundary, or "how far through are
  // we" is measured against a window that does not line up with the calendar
  // the actual spending is reported in.
  const day = Number(input.startsOn.slice(8, 10));
  if (day !== 1) {
    return Response.json(
      { ok: false, error: 'A budget period starts on the first of a month.' },
      { status: 400 },
    );
  }
  const month = Number(input.startsOn.slice(5, 7));
  if (input.period === 'quarter' && ![1, 4, 7, 10].includes(month)) {
    return Response.json(
      { ok: false, error: 'A quarterly budget starts in January, April, July or October.' },
      { status: 400 },
    );
  }
  if (input.period === 'year' && month !== 1) {
    return Response.json(
      { ok: false, error: 'A yearly budget starts in January.' },
      { status: 400 },
    );
  }

  const db = createSupabaseServerClient();

  const { data, error } = await db
    .from('budgets')
    .upsert(
      {
        name: input.name,
        scope: input.scope,
        scope_id: input.scopeId ?? null,
        scope_key: input.scopeKey ?? null,
        period: input.period,
        starts_on: input.startsOn,
        amount_minor: input.amountMinor,
        notes: input.notes ?? null,
        is_active: true,
      },
      // Setting the same scope and period again is an EDIT. Without this the
      // page would show two figures for one budget and neither would be wrong.
      { onConflict: 'scope,scope_id,scope_key,period,starts_on' },
    )
    .select('id')
    .single();

  if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });

  const id = (data as { id: string }).id;
  await recordAudit(
    db,
    [
      {
        table_name: 'budgets',
        record_id: id,
        field: 'amount_minor',
        old_value: null,
        new_value: String(input.amountMinor),
        reason: `Budget set: ${input.name}`,
      },
    ],
    auth.session.user,
  );

  return Response.json({ ok: true, id });
}

export async function DELETE(request: Request) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'Missing id.' }, { status: 400 });

  const db = createSupabaseServerClient();
  // Deactivated rather than deleted: a budget that existed is part of how a
  // past period was judged, and the audit trail refers to it by id.
  const { error } = await db.from('budgets').update({ is_active: false }).eq('id', id);
  if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });

  await recordAudit(
    db,
    [
      {
        table_name: 'budgets',
        record_id: id,
        field: 'is_active',
        old_value: 'true',
        new_value: 'false',
        reason: 'Budget retired',
      },
    ],
    auth.session.user,
  );

  return Response.json({ ok: true });
}
