import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { callerKey, crossOriginRefusal, rateLimitRefusal } from '@/lib/security';
import { createSupabaseAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { ingestTransactions } from '@/lib/ingest';
import { today } from '@/lib/dates';
import { SCREENSHOT_MODEL } from '@/lib/image-import/read-screenshot';
import { externalIdFor, parseScreenDateTime, postedAtOf, rowKey, statusOf } from '@/lib/image-import/review';
import type { NormalizedTransaction } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Save the screenshot rows a person has checked.
 *
 * NOTHING THE BROWSER SENDS IS TAKEN ON TRUST. The rows arrive after human
 * review — possibly edited, which is the point — but the rules that decide
 * what counts as money are re-applied here, on the server, from scratch:
 *
 *   - status: a row the bank showed as failed, pending or unrecognised is
 *     refused, whatever the browser claims;
 *   - date: a real calendar day, not in the future;
 *   - amount: a positive whole number of minor units;
 *   - currency: the account's own — a USD figure in a VND account is refused
 *     rather than converted by accident;
 *   - identity: recomputed from the values being saved, so importing the same
 *     screenshot twice adds nothing.
 *
 * Then the rows take exactly the path a CSV import takes: a `manual_imports`
 * record first, so every transaction points back to its import, and the same
 * `ingestTransactions` — same categorisation, same duplicate detection, same
 * alerts.
 */
const Row = z.object({
  txnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable(),
  amountMinor: z.number().int().positive().max(1_000_000_000_000),
  currency: z.string().trim().length(3).toUpperCase(),
  direction: z.enum(['inflow', 'outflow']),
  counterpartyName: z.string().trim().max(200).nullable(),
  counterpartyBank: z.string().trim().max(200).nullable(),
  counterpartyAccount: z.string().trim().max(64).nullable(),
  description: z.string().trim().max(500).nullable(),
  reference: z.string().trim().max(64).nullable(),
  transferType: z.string().trim().max(64).nullable(),
  statusText: z.string().trim().max(64).nullable(),
  postedScreen: z.boolean(),
  /** What the model read before a person changed it — kept for the audit trail. */
  edited: z.boolean(),
  original: z.record(z.unknown()).nullable(),
  /** Which model read it — a fallback may have answered instead of the one asked. */
  readBy: z.string().trim().max(80).nullable().optional(),
});

const Body = z.object({
  accountId: z.string().uuid(),
  images: z.array(z.string().trim().max(200)).min(1).max(50),
  rows: z.array(Row).min(1).max(500),
});

export async function POST(request: Request) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  const tooMany = rateLimitRefusal(callerKey(request, 'screenshot-commit'), { limit: 10, windowMs: 60_000 });
  if (tooMany) return tooMany;

  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return Response.json(
      { ok: false, error: `Row data is not valid: ${issue?.path.join('.')} ${issue?.message}` },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // Written with the service role, AFTER the capability check above — the
  // same arrangement as the CSV import. `manual_imports` deliberately has no
  // insert policy: nobody writes an import record through the API directly,
  // only this server, once it has decided the person may. (Found by running
  // it: the user-scoped client was refused, as it should have been.)
  if (!isAdminConfigured()) {
    return Response.json({ ok: false, error: 'Supabase service role is not configured.' }, { status: 503 });
  }
  const db = createSupabaseAdminClient();
  const { data: account, error: accountError } = await db
    .from('financial_accounts')
    .select('id,name,currency')
    .eq('id', input.accountId)
    .maybeSingle();
  if (accountError) return Response.json({ ok: false, error: accountError.message }, { status: 400 });
  if (!account) return Response.json({ ok: false, error: 'No such account.' }, { status: 404 });
  const accountCurrency = String(account.currency).toUpperCase();

  // ── the rules, again ──────────────────────────────────────────────────────
  const asOf = today();
  const tomorrow = new Date(`${asOf}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const latest = tomorrow.toISOString().slice(0, 10);

  const refusals: string[] = [];
  input.rows.forEach((r, i) => {
    const label = `Row ${i + 1}`;
    if (statusOf(r.statusText, r.postedScreen) !== 'successful') {
      refusals.push(`${label}: the bank does not show it as completed, so no money moved.`);
    }
    const [y, m, d] = r.txnDate.split('-');
    if (!parseScreenDateTime(`${d}/${m}/${y}`)) refusals.push(`${label}: ${r.txnDate} is not a real date.`);
    else if (r.txnDate > latest) refusals.push(`${label}: ${r.txnDate} is in the future.`);
    if (r.currency !== accountCurrency) {
      refusals.push(`${label}: ${r.currency} does not belong in ${account.name}, which is ${accountCurrency}.`);
    }
  });
  if (refusals.length) {
    return Response.json({ ok: false, error: 'Some rows cannot be saved.', refusals: refusals.slice(0, 20) }, { status: 400 });
  }

  // ── record the import, then ingest ───────────────────────────────────────
  const fileName =
    input.images.length === 1
      ? input.images[0]!
      : `${input.images.length} screenshots: ${input.images.join(', ')}`.slice(0, 250);

  const { data: importRow, error: importError } = await db
    .from('manual_imports')
    .insert({
      source_label: 'image_vn_bank',
      account_id: account.id,
      file_name: fileName,
      row_count: input.rows.length,
      imported_by: auth.session.user.id,
      column_map: {
        kind: 'screenshot',
        read_by: [...new Set(input.rows.map((r) => r.readBy ?? SCREENSHOT_MODEL))].join(', '),
        images: input.images,
        edited_rows: input.rows.filter((r) => r.edited).length,
      },
    })
    .select('id')
    .single();
  if (importError || !importRow) {
    return Response.json({ ok: false, error: `Could not record the import: ${importError?.message}` }, { status: 500 });
  }
  const manualImportId = (importRow as { id: string }).id;

  const transactions: NormalizedTransaction[] = input.rows.map((r) => {
    const key = rowKey(r);
    return {
      account_id: account.id as string,
      txn_date: r.txnDate,
      posted_at: postedAtOf(r.txnDate, r.time),
      amount_minor: r.amountMinor,
      currency: accountCurrency,
      direction: r.direction,
      description: r.description ?? r.transferType ?? 'Bank transfer',
      counterparty_name: r.counterpartyName,
      source_system: 'image_vn_bank',
      external_txn_id: externalIdFor(account.id as string, key),
      manual_import_id: manualImportId,
      raw: {
        source: 'screenshot',
        read_by: r.readBy ?? SCREENSHOT_MODEL,
        reference: r.reference,
        transfer_type: r.transferType,
        counterparty_bank: r.counterpartyBank,
        counterparty_account: r.counterpartyAccount,
        status_text: r.statusText,
        // A corrected figure is legitimate — that is what review is for — and
        // the record keeps both, so nobody later mistakes a fix for the reading.
        edited_by_reviewer: r.edited,
        model_reading: r.original,
      },
    };
  });

  // The same transaction twice in one save — two readings corrected into the
  // same values — is one transaction, and is reported as such.
  const seenIds = new Set<string>();
  const unique = transactions.filter((t) => {
    if (seenIds.has(t.external_txn_id)) return false;
    seenIds.add(t.external_txn_id);
    return true;
  });
  const duplicatesInBatch = transactions.length - unique.length;
  const result = await ingestTransactions(db, unique, { asOf });

  await db
    .from('manual_imports')
    .update({ inserted_count: result.inserted, skipped_count: result.duplicatesSkipped + duplicatesInBatch })
    .eq('id', manualImportId);

  return Response.json({
    ok: true,
    importId: manualImportId,
    inserted: result.inserted,
    skipped: result.duplicatesSkipped,
    duplicatesInBatch,
    flaggedAsPossibleDuplicate: result.flaggedAsPossibleDuplicate,
    errors: result.errors,
  });
}
