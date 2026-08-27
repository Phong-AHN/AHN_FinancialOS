import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { createSupabaseAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { CSV_PRESETS, mapRowsToTransactions, parseCsv, type ColumnMap } from '@/lib/connectors/csv';
import { ingestTransactions } from '@/lib/ingest';
import { today } from '@/lib/dates';
import type { FinancialAccount } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ImportSchema = z.object({
  csv: z.string().min(1).max(8_000_000),
  fileName: z.string().min(1).max(300),
  accountId: z.string().uuid(),
  preset: z.string().min(1).max(40),
  columnMap: z.object({
    date: z.string().min(1),
    description: z.string().optional(),
    amount: z.string().optional(),
    debit: z.string().optional(),
    credit: z.string().optional(),
    counterparty: z.string().optional(),
    category: z.string().optional(),
    currency: z.string().optional(),
    reference: z.string().optional(),
    balance: z.string().optional(),
  }),
  dayFirst: z.boolean().default(false),
  decimalSeparator: z.enum(['.', ',']).default('.'),
  forceOutflow: z.boolean().default(false),
});

/**
 * CSV import - MVP Plan Day 1 and Day 6.
 *
 * The server re-parses the uploaded text itself rather than trusting rows
 * produced in the browser: the preview is a convenience, not the source of what
 * gets written. Everything then flows through the same `ingestTransactions`
 * path as the API connectors, so imported rows are categorised, USD-stamped and
 * duplicate-checked exactly like the rest.
 */
export async function POST(request: Request) {
  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  if (!isAdminConfigured()) {
    return Response.json(
      { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY is not set, so importing cannot run.' },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = ImportSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: `Invalid import request: ${parsed.error.issues[0]?.message ?? 'bad input'}` },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const map = input.columnMap as ColumnMap;
  if (!map.amount && !map.debit && !map.credit) {
    return Response.json(
      { ok: false, error: 'Map either a signed amount column or a debit/credit pair.' },
      { status: 400 },
    );
  }

  const db = createSupabaseAdminClient();
  const preset = CSV_PRESETS[input.preset] ?? CSV_PRESETS.generic!;

  const { data: accountRow } = await db
    .from('financial_accounts')
    .select('*')
    .eq('id', input.accountId)
    .maybeSingle();

  if (!accountRow) {
    return Response.json({ ok: false, error: 'That account does not exist.' }, { status: 400 });
  }
  const account = accountRow as FinancialAccount;

  const { rows } = parseCsv(input.csv);
  if (rows.length === 0) {
    return Response.json({ ok: false, error: 'The file has no data rows.' }, { status: 400 });
  }

  // Record the import first, so every transaction it produces can point back to
  // the file it came from (spec 28: traceable to source).
  const { data: importRow, error: importError } = await db
    .from('manual_imports')
    .insert({
      source_label: preset.sourceSystem,
      account_id: account.id,
      file_name: input.fileName,
      row_count: rows.length,
      imported_by: auth.session.user.id,
      column_map: { ...map, dayFirst: input.dayFirst, decimalSeparator: input.decimalSeparator },
    })
    .select('id')
    .single();

  if (importError || !importRow) {
    return Response.json(
      { ok: false, error: `Could not record the import: ${importError?.message}` },
      { status: 500 },
    );
  }
  const manualImportId = (importRow as { id: string }).id;

  const mapped = mapRowsToTransactions(rows, map, {
    accountId: account.id,
    sourceSystem: preset.sourceSystem,
    defaultCurrency: account.currency,
    dayFirst: input.dayFirst,
    decimalSeparator: input.decimalSeparator,
    forceDirection: input.forceOutflow ? 'outflow' : undefined,
    manualImportId,
    fileName: input.fileName,
  });

  const result = await ingestTransactions(db, mapped.transactions, { asOf: today() });

  await db
    .from('manual_imports')
    .update({
      inserted_count: result.inserted,
      skipped_count: result.duplicatesSkipped + mapped.errors.length,
    })
    .eq('id', manualImportId);

  return Response.json({
    ok: true,
    importId: manualImportId,
    rows: rows.length,
    inserted: result.inserted,
    skipped: result.duplicatesSkipped,
    rowErrors: mapped.errors.length,
    flaggedAsPossibleDuplicate: result.flaggedAsPossibleDuplicate,
    errors: [...result.errors, ...mapped.errors.slice(0, 10).map((e) => `Row ${e.rowNumber}: ${e.reason}`)],
  });
}
