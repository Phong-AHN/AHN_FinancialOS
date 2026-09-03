import { requireApiSession } from '@/lib/auth';
import { callerKey, crossOriginRefusal, rateLimitRefusal } from '@/lib/security';
import { createSupabaseAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { categorize } from '@/lib/categorize';
import { RULE_AUDIT_REASON, isAutomatedAudit, recordAudit } from '@/lib/audit';
import type { AuditLog, Transaction } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Re-run the categorisation rules over transactions still marked uncategorised.
 *
 * Rules improve — a new SaaS vendor, a chart-of-accounts name the ledger uses —
 * but `ingestTransactions` only categorises on insert, so yesterday's rows keep
 * yesterday's verdict. This is the catch-up pass.
 *
 * TWO THINGS IT MUST NEVER DO:
 *
 *   1. Overwrite a human correction. Any row carrying an audit-log entry a
 *      person wrote was decided by a person, and a rule does not outrank that.
 *      Its own past entries are excluded, or it would freeze itself out.
 *   2. Touch a row that already has a category. Only `uncategorized` and null
 *      are eligible, so re-running is safe and idempotent.
 *
 * Every change it does make is written to the audit log like any other edit
 * (spec §24), attributed to whoever pressed the button.
 */
export async function POST(request: Request) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  // Re-reads every uncategorised row and writes an audit entry per change.
  const tooMany = rateLimitRefusal(callerKey(request, 'recategorize'), {
    limit: 4,
    windowMs: 60000,
  });
  if (tooMany) return tooMany;

  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  if (!isAdminConfigured()) {
    return Response.json({ ok: false, error: 'Supabase service role is not configured.' }, { status: 500 });
  }

  const db = createSupabaseAdminClient();

  const { data: rows, error } = await db
    .from('transactions')
    .select('id,description,category,subcategory,direction,counterparty_id,source_system')
    .or('category.is.null,category.eq.uncategorized')
    .limit(5000);

  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const candidates = (rows ?? []) as Array<
    Pick<Transaction, 'id' | 'description' | 'category' | 'subcategory' | 'direction' | 'counterparty_id' | 'source_system'>
  >;

  if (candidates.length === 0) {
    return Response.json({ ok: true, examined: 0, updated: 0, protected: 0, stillUncategorized: 0 });
  }

  // One query for every human decision, rather than one per row.
  //
  // Any audited field counts, not just `category`: somebody who corrected
  // `is_internal_transfer` by hand has ruled on this row, and a rule does not
  // outrank that. But this pass writes audit entries of its own, so it has to
  // skip its own handwriting — otherwise it reads its last run as a human
  // verdict and can never revisit a row again, which is precisely what would
  // freeze in every miscategorised row the rules have since learned to fix.
  const { data: edits } = await db
    .from('audit_logs')
    .select('record_id,reason')
    .eq('table_name', 'transactions')
    .in('record_id', candidates.map((c) => c.id));

  const humanDecided = new Set(
    (edits ?? [])
      .map((e) => e as Pick<AuditLog, 'record_id' | 'reason'>)
      .filter((e) => !isAutomatedAudit(e.reason))
      .map((e) => e.record_id),
  );

  // Counterparty names sharpen the guess; fetch them in one go.
  const counterpartyIds = [...new Set(candidates.map((c) => c.counterparty_id).filter(Boolean))] as string[];
  const names = new Map<string, string>();
  if (counterpartyIds.length) {
    const { data: parties } = await db
      .from('counterparties')
      .select('id,name')
      .in('id', counterpartyIds);
    for (const p of parties ?? []) {
      const row = p as { id: string; name: string };
      names.set(row.id, row.name);
    }
  }

  let updated = 0;
  let stillUncategorized = 0;
  const errors: string[] = [];

  for (const row of candidates) {
    if (humanDecided.has(row.id)) continue;

    const guess = categorize({
      description: row.description,
      counterpartyName: row.counterparty_id ? (names.get(row.counterparty_id) ?? null) : null,
      ledgerAccount: row.subcategory,
      sourceSystem: row.source_system,
      direction: row.direction,
    });

    if (guess.matchedRule === null || guess.category === 'uncategorized') {
      stillUncategorized++;
      continue;
    }

    const patch = {
      category: guess.category,
      subcategory: row.subcategory ?? guess.subcategory,
      is_subscription: guess.isSubscription,
      is_recurring: guess.isRecurring,
      // The most consequential field the categoriser produces, and it used to
      // be dropped here. `is_internal_transfer` decides whether a row counts
      // toward revenue, expense, burn and break-even — so a credit-card
      // payment left unflagged is counted as spend on top of the charges it
      // settles, and shows up again as a "recurring subscription".
      is_internal_transfer: guess.isInternalTransfer,
    };

    const { error: updateError } = await db.from('transactions').update(patch).eq('id', row.id);
    if (updateError) {
      errors.push(`${row.id}: ${updateError.message}`);
      continue;
    }

    await recordAudit(
      db,
      [
        {
          table_name: 'transactions',
          record_id: row.id,
          field: 'category',
          old_value: row.category,
          new_value: guess.category,
          reason: `${RULE_AUDIT_REASON} (matched "${guess.matchedRule}")`,
        },
      ],
      auth.session.user,
    );
    updated++;
  }

  return Response.json({
    ok: true,
    examined: candidates.length,
    updated,
    protected: [...humanDecided].length,
    stillUncategorized,
    errors: errors.slice(0, 5),
  });
}
