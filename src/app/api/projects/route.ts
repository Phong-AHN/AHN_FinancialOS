import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { crossOriginRefusal } from '@/lib/security';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { recordAudit } from '@/lib/audit';
import { normalizeName } from '@/lib/categorize';

export const dynamic = 'force-dynamic';

/**
 * Create a project or an event - Spec sections 12, 14, 15.
 *
 * Money arrives in minor units and is validated as an integer, so a project's
 * contracted value can never enter the system as a float. Every other amount in
 * this codebase obeys the same rule; a contract value that drifted by a cent
 * would then quietly poison every variance measured against it.
 */
const CreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['project', 'event']).default('project'),
  businessUnitId: z.string().uuid().nullable().optional(),
  clientName: z.string().trim().max(200).nullable().optional(),
  service: z.string().trim().max(200).nullable().optional(),
  contractedRevenueMinor: z.number().int().nonnegative().nullable().optional(),
  budgetExpenseMinor: z.number().int().nonnegative().nullable().optional(),
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

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'Invalid project fields.' }, { status: 400 });
  }
  const input = parsed.data;

  const db = createSupabaseServerClient();

  // A client named twice is one client. `normalized_name` is unique, so the
  // second project for the same client links to the existing row rather than
  // splitting that client's P&L across two spellings of their name.
  let clientId: string | null = null;
  if (input.clientName) {
    const normalized = normalizeName(input.clientName);
    const { data: existing } = await db
      .from('clients')
      .select('id')
      .eq('normalized_name', normalized)
      .maybeSingle();

    if (existing) {
      clientId = (existing as { id: string }).id;
    } else {
      const { data: created, error } = await db
        .from('clients')
        .insert({ name: input.clientName, normalized_name: normalized })
        .select('id')
        .single();
      if (error) {
        return Response.json({ ok: false, error: error.message }, { status: 400 });
      }
      clientId = (created as { id: string }).id;
    }
  }

  // Single-entity today, but the column exists so a second entity does not need
  // a migration. Picking the only company is right; guessing between two is not.
  const { data: companies } = await db.from('companies').select('id').limit(2);
  const companyId = (companies ?? []).length === 1 ? (companies![0] as { id: string }).id : null;

  const { data, error } = await db
    .from('projects')
    .insert({
      name: input.name,
      kind: input.kind,
      company_id: companyId,
      business_unit_id: input.businessUnitId ?? null,
      client_id: clientId,
      service: input.service ?? null,
      contracted_revenue_minor: input.contractedRevenueMinor ?? null,
      budget_expense_minor: input.budgetExpenseMinor ?? null,
    })
    .select('id')
    .single();

  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 400 });
  }

  const id = (data as { id: string }).id;
  await recordAudit(
    db,
    [
      {
        table_name: 'projects',
        record_id: id,
        field: 'created',
        old_value: null,
        new_value: input.name,
        reason: `Created ${input.kind}`,
      },
    ],
    auth.session.user,
  );

  return Response.json({ ok: true, id });
}
