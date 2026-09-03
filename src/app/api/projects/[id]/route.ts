import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { crossOriginRefusal } from '@/lib/security';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { recordAudit } from '@/lib/audit';
import { formatMoney } from '@/lib/money';

export const dynamic = 'force-dynamic';

/**
 * Correct a project after it exists - Spec sections 12, 14, 15.
 *
 * Projects were create-and-attribute only. A typo in a name, a project that
 * finished, or a contract value that arrived a week later all needed the SQL
 * console — on the very table AHN is about to fill in by hand for the first
 * time. Data entry that cannot be corrected is data entry nobody starts.
 *
 * The boundary is `p_projects_write` (`can_manage_projects()`), enforced on the
 * caller's own session client, and migration 0025 scopes a department lead to
 * the unit they lead. Nothing here re-checks that.
 *
 * `business_unit_id` is deliberately NOT editable. Moving a project between
 * units silently restates two business units' historical margins, and migration
 * 0025 scopes write access by unit — so a lead could move a project into their
 * own unit and then edit it. That is a transfer, not a correction, and it
 * belongs to whoever can see the whole picture.
 */
const PatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    status: z.enum(['planned', 'active', 'completed', 'cancelled']).optional(),
    service: z.string().trim().max(120).nullable().optional(),
    startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    /**
     * Spec §12 asks for contracted and invoiced revenue. Both are nullable and
     * stay that way: null means "nobody has told us", and a zero would read as
     * "nothing was contracted" — a different and wrong claim.
     */
    contractedRevenueMinor: z.number().int().nonnegative().nullable().optional(),
    invoicedRevenueMinor: z.number().int().nonnegative().nullable().optional(),
    budgetExpenseMinor: z.number().int().nonnegative().nullable().optional(),
    estimatedHours: z.number().nonnegative().max(1_000_000).nullable().optional(),
    labourBudgetMinor: z.number().int().nonnegative().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });

/** Column name, and how to render the value in an audit entry. */
const FIELDS: Array<{ key: keyof z.infer<typeof PatchSchema>; column: string; money?: boolean }> = [
  { key: 'name', column: 'name' },
  { key: 'status', column: 'status' },
  { key: 'service', column: 'service' },
  { key: 'startsOn', column: 'starts_on' },
  { key: 'endsOn', column: 'ends_on' },
  { key: 'contractedRevenueMinor', column: 'contracted_revenue_minor', money: true },
  { key: 'invoicedRevenueMinor', column: 'invoiced_revenue_minor', money: true },
  { key: 'budgetExpenseMinor', column: 'budget_expense_minor', money: true },
  { key: 'estimatedHours', column: 'estimated_hours' },
  { key: 'labourBudgetMinor', column: 'labour_budget_minor', money: true },
];

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  const auth = await requireApiSession({ capability: 'manage_projects' });
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
  const input = parsed.data;
  const db = createSupabaseServerClient();

  const { data: before } = await db
    .from('projects')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (!before) return Response.json({ ok: false, error: 'No such project.' }, { status: 404 });
  const prior = before as Record<string, unknown>;

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const f of FIELDS) {
    if (input[f.key] !== undefined) patch[f.column] = input[f.key];
  }

  if (
    typeof patch.starts_on === 'string' &&
    typeof patch.ends_on === 'string' &&
    patch.ends_on < patch.starts_on
  ) {
    return Response.json(
      { ok: false, error: 'The end date is before the start date.' },
      { status: 400 },
    );
  }

  const { error } = await db.from('projects').update(patch).eq('id', params.id);
  if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });

  // Every one of these changes a reported figure: a contract value moves the
  // unbilled total, a status moves a project in and out of the active roll-up.
  const show = (v: unknown, money?: boolean) =>
    v === null || v === undefined
      ? null
      : money && typeof v === 'number'
        ? formatMoney(v)
        : String(v);

  const entries = FIELDS.filter(
    (f) => input[f.key] !== undefined && input[f.key] !== prior[f.column],
  ).map((f) => ({
    table_name: 'projects',
    record_id: params.id,
    field: f.column,
    old_value: show(prior[f.column], f.money),
    new_value: show(input[f.key], f.money),
    reason: 'Project edited',
  }));

  if (entries.length > 0) await recordAudit(db, entries, auth.session.user);

  return Response.json({ ok: true, id: params.id, changed: entries.length });
}
