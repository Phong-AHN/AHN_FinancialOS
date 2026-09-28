import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { callerKey, crossOriginRefusal, rateLimitRefusal } from '@/lib/security';
import { createSupabaseAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { recordAudit } from '@/lib/audit';
import { parseAmountToMinor } from '@/lib/money';
import type { FinancialAccount } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Correct an account's standing facts.
 *
 * WHY THIS EXISTS. Until now an account could be created and never corrected.
 * That left no way to fix the two things that distort the cash figure most:
 *
 *   - an account whose TYPE is wrong, so a credit card is counted as cash;
 *   - an account that is no longer used — a sample account inside the books, a
 *     closed bank account — still adding its balance to the company total.
 *
 * Both were live in AHN's own ledger: a credit card typed as `checking` and
 * counted as cash, and two accounts holding 75% of the reported cash whose
 * provider balance disagreed with their own transactions by a factor of six.
 * There was no screen for either, so the dashboard could be read as wrong and
 * not put right.
 *
 * WHAT CANNOT BE CHANGED HERE, and why:
 *
 *   - `currency`: the transactions under it are already stored in that
 *     currency. Changing the label would reinterpret every historical row as a
 *     different amount of money. Make a new account and move the statement.
 *   - `reported_balance_minor` on a connected account: the provider owns that
 *     number and the next sync overwrites it. Fix it at the bank or in
 *     QuickBooks. On a MANUAL account — a CSV or screenshot import, where no
 *     provider ever reports — it can be set here, because otherwise nothing can
 *     ever set it.
 *   - `company_id`: moving an account between entities moves its whole history
 *     across a legal boundary. That is a migration, not an edit.
 *
 * EVERY CHANGE IS WRITTEN TO THE AUDIT LOG, field by field, with a reason. A
 * change to `include_in_cash` changes the headline cash figure for the whole
 * company; six months later somebody will ask why the number moved, and the
 * answer has to exist.
 */
const PatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  type: z.enum(['checking', 'savings', 'credit_card', 'payment_processor', 'cash', 'other']).optional(),
  includeInCash: z.boolean().optional(),
  isActive: z.boolean().optional(),
  /** As typed, in the account's own currency: "12,500.50" or "6.500.000". */
  openingBalance: z.string().max(40).optional(),
  /** Manual accounts only — the statement's closing balance. */
  reportedBalance: z.string().max(40).nullable().optional(),
  reason: z.string().trim().max(500).optional(),
});

const PROVIDER_OWNED = new Set(['quickbooks', 'plaid', 'stripe', 'veem', 'vietinbank', 'finverse']);

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;

  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  const tooMany = rateLimitRefusal(callerKey(request, 'account-edit'), { limit: 60, windowMs: 60 * 60_000 });
  if (tooMany) return tooMany;

  const auth = await requireApiSession({ capability: 'move_money' });
  if ('response' in auth) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return Response.json(
      { ok: false, error: `Not a valid change: ${issue?.path.join('.')} ${issue?.message}` },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const db = createSupabaseServerClient();
  const { data, error } = await db.from('financial_accounts').select('*').eq('id', params.id).maybeSingle();
  if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });
  if (!data) return Response.json({ ok: false, error: 'No such account.' }, { status: 404 });
  const account = data as FinancialAccount;

  // ── build the patch, refusing what this route must not decide ─────────────
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.type !== undefined) patch.type = input.type;
  if (input.includeInCash !== undefined) patch.include_in_cash = input.includeInCash;
  if (input.isActive !== undefined) patch.is_active = input.isActive;

  if (input.openingBalance !== undefined) {
    const minor = parseAmountToMinor(input.openingBalance || '0', account.currency);
    if (minor === null) {
      return Response.json(
        { ok: false, error: `Could not read "${input.openingBalance}" as an amount in ${account.currency}.` },
        { status: 400 },
      );
    }
    patch.opening_balance_minor = minor;
  }

  if (input.reportedBalance !== undefined) {
    if (PROVIDER_OWNED.has(account.source_system)) {
      return Response.json(
        {
          ok: false,
          error: `${account.name} gets its balance from ${account.source_system.replace(/_/g, ' ')}, and the next sync would overwrite anything set here. Correct it at the provider, then sync.`,
        },
        { status: 400 },
      );
    }
    if (input.reportedBalance === null || input.reportedBalance === '') {
      patch.reported_balance_minor = null;
      patch.reported_balance_at = null;
    } else {
      const minor = parseAmountToMinor(input.reportedBalance, account.currency);
      if (minor === null) {
        return Response.json(
          { ok: false, error: `Could not read "${input.reportedBalance}" as an amount in ${account.currency}.` },
          { status: 400 },
        );
      }
      patch.reported_balance_minor = minor;
      patch.reported_balance_at = new Date().toISOString();
    }
  }

  // Only the fields that actually differ, so re-saving an untouched form writes
  // nothing and leaves no audit noise.
  const before = account as unknown as Record<string, unknown>;
  const changed = Object.fromEntries(
    Object.entries(patch).filter(([field, value]) => before[field] !== value && field !== 'reported_balance_at'),
  );
  if (Object.keys(changed).length === 0) {
    return Response.json({ ok: true, changed: 0, message: 'Nothing was different.' });
  }
  if ('reported_balance_minor' in changed && 'reported_balance_at' in patch) {
    changed.reported_balance_at = patch.reported_balance_at;
  }

  if (!isAdminConfigured()) {
    return Response.json({ ok: false, error: 'Supabase service role is not configured.' }, { status: 503 });
  }
  const admin = createSupabaseAdminClient();
  const { error: updateError } = await admin.from('financial_accounts').update(changed).eq('id', account.id);
  if (updateError) {
    return Response.json({ ok: false, error: updateError.message }, { status: 400 });
  }

  await recordAudit(
    admin,
    Object.entries(changed)
      .filter(([field]) => field !== 'reported_balance_at')
      .map(([field, value]) => ({
        table_name: 'financial_accounts',
        record_id: account.id,
        field,
        old_value: before[field] === null || before[field] === undefined ? null : String(before[field]),
        new_value: value === null || value === undefined ? null : String(value),
        reason: input.reason?.trim() || `Corrected by ${auth.session.email}`,
      })),
    auth.session.user,
  );

  return Response.json({
    ok: true,
    changed: Object.keys(changed).filter((f) => f !== 'reported_balance_at').length,
  });
}
