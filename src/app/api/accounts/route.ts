import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { crossOriginRefusal } from '@/lib/security';
import { createSupabaseAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { ensureDefaultCompany } from '@/lib/sync';
import { parseAmountToMinor } from '@/lib/money';

export const dynamic = 'force-dynamic';

const AccountSchema = z.object({
  name: z.string().min(1).max(200),
  companyId: z.string().uuid().nullable().optional(),
  type: z.enum(['checking', 'savings', 'credit_card', 'payment_processor', 'cash', 'other']),
  currency: z.string().length(3),
  openingBalance: z.string().max(40).default('0'),
  includeInCash: z.boolean().default(true),
});

/**
 * Create a manual account for CSV-imported statements (VN bank, VEEM, payroll).
 * API-connected accounts are created by the sync itself and are keyed on their
 * external id, so they never collide with these.
 */
export async function POST(request: Request) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  if (!isAdminConfigured()) {
    return Response.json({ ok: false, error: 'Supabase service role is not configured.' }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = AccountSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'Invalid account details.' }, { status: 400 });
  }
  const input = parsed.data;
  const currency = input.currency.toUpperCase();

  const opening = parseAmountToMinor(input.openingBalance || '0', currency);
  if (opening === null) {
    return Response.json({ ok: false, error: 'Could not read the opening balance.' }, { status: 400 });
  }

  const db = createSupabaseAdminClient();
  const companyId = input.companyId ?? (await ensureDefaultCompany(db));

  const { data, error } = await db
    .from('financial_accounts')
    .insert({
      company_id: companyId,
      name: input.name.trim(),
      type: input.type,
      currency,
      source_system: 'manual',
      // Unique per manual account, so the (source_system, external_account_id)
      // index never collides with a second hand-made account.
      external_account_id: `manual:${crypto.randomUUID()}`,
      opening_balance_minor: opening,
      include_in_cash: input.includeInCash,
    })
    .select('id,name')
    .single();

  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 400 });
  }

  return Response.json({ ok: true, ...(data as { id: string; name: string }) });
}
