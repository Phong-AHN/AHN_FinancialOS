import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { crossOriginRefusal } from '@/lib/security';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Save a scenario - Spec section 11.
 *
 * What is stored is the INPUTS and the BASELINE, never the computed figures.
 *
 * A plan made in June compounded June's revenue; re-running it against today's
 * baseline would silently change what somebody agreed to. And storing the
 * outputs would freeze them against whatever the engine did that month, so the
 * first improvement to the arithmetic would leave a saved plan disagreeing with
 * a fresh one built from identical inputs. Keeping both halves is what makes a
 * saved scenario a record rather than a live query.
 */
const SaveSchema = z.object({
  name: z.string().trim().min(1).max(120),
  revenueGrowthRate: z.number().min(-1).max(10),
  expenseGrowthRate: z.number().min(-1).max(10),
  months: z.number().int().min(1).max(60),
  /** Null for a growth projection rather than a margin target. */
  targetMarginRatio: z.number().min(-10).lt(1).nullable().optional(),
  marginBasis: z.enum(['net', 'gross']).nullable().optional(),
  baselineRevenueUsdMinor: z.number().int().nonnegative(),
  baselineExpenseUsdMinor: z.number().int().nonnegative(),
  baselineMonthsSampled: z.number().int().nonnegative(),
  baselineAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(500).nullable().optional(),
});

export async function POST(request: Request) {
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

  const parsed = SaveSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? 'That scenario is not valid.' },
      { status: 400 },
    );
  }
  const s = parsed.data;

  const db = createSupabaseServerClient();
  const { data, error } = await db
    .from('scenarios')
    .insert({
      name: s.name,
      revenue_growth_rate: s.revenueGrowthRate,
      expense_growth_rate: s.expenseGrowthRate,
      months: s.months,
      target_margin_ratio: s.targetMarginRatio ?? null,
      margin_basis: s.marginBasis ?? null,
      baseline_revenue_usd_minor: s.baselineRevenueUsdMinor,
      baseline_expense_usd_minor: s.baselineExpenseUsdMinor,
      baseline_months_sampled: s.baselineMonthsSampled,
      baseline_as_of: s.baselineAsOf,
      notes: s.notes ?? null,
      created_by: auth.session.user.id,
    })
    .select('id')
    .single();

  if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });
  return Response.json({ ok: true, id: (data as { id: string }).id });
}

export async function DELETE(request: Request) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'Missing id.' }, { status: 400 });

  const db = createSupabaseServerClient();
  const { error } = await db.from('scenarios').delete().eq('id', id);
  if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });
  return Response.json({ ok: true });
}
