import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { crossOriginRefusal } from '@/lib/security';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { recordAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Employees and contractors, with what an hour of their time costs.
 *
 * Spec section 13 names three costing bases and this validates that the one
 * chosen arrives with its number. A basis without a rate is not a partial
 * record — it silently prices every hour that person logs at zero, which makes
 * their time free and quietly improves every project they touch.
 */
const CreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(320).nullable().optional(),
    kind: z.enum(['employee', 'contractor']).default('employee'),
    basis: z.enum(['salaried', 'hourly', 'contractor_rate']).default('salaried'),
    annualCostMinor: z.number().int().nonnegative().nullable().optional(),
    hourlyCostMinor: z.number().int().nonnegative().nullable().optional(),
    annualHours: z.number().positive().max(8760).default(1880),
  })
  .refine(
    (v) =>
      v.basis === 'salaried'
        ? typeof v.annualCostMinor === 'number'
        : typeof v.hourlyCostMinor === 'number',
    { message: 'That costing basis needs its rate.' },
  );

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

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid fields.' },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const db = createSupabaseServerClient();
  const { data, error } = await db
    .from('people')
    .insert({
      name: input.name,
      email: input.email ?? null,
      kind: input.kind,
      basis: input.basis,
      annual_cost_minor: input.basis === 'salaried' ? (input.annualCostMinor ?? null) : null,
      hourly_cost_minor: input.basis === 'salaried' ? null : (input.hourlyCostMinor ?? null),
      annual_hours: input.annualHours,
    })
    .select('id')
    .single();

  if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });

  const id = (data as { id: string }).id;
  // A rate is compensation, so creating one is auditable like any other
  // financial control. The rate itself is deliberately NOT written to the log.
  await recordAudit(
    db,
    [
      {
        table_name: 'people',
        record_id: id,
        field: 'created',
        old_value: null,
        new_value: input.name,
        reason: `Added ${input.kind} on a ${input.basis} basis`,
      },
    ],
    auth.session.user,
  );

  return Response.json({ ok: true, id });
}
