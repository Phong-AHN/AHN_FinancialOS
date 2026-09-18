import { requireApiSession } from '@/lib/auth';
import { callerKey, rateLimitRefusal } from '@/lib/security';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { loadTransactions, type TransactionFilters } from '@/lib/data';
import { toMajor } from '@/lib/money';
import { today } from '@/lib/dates';
import { categoryLabel } from '@/lib/categorize';

export const dynamic = 'force-dynamic';

/** A hard ceiling, so one click cannot pull the whole ledger into memory. */
const MAX_ROWS = 10_000;

/**
 * The transactions on screen, as a file.
 *
 * WHY A SERVER ROUTE AND NOT A BUTTON THAT SERIALISES THE TABLE. The table
 * shows a page — eight rows on the home screen, a hundred on the transactions
 * page. Exporting what is rendered would quietly hand somebody eight rows when
 * they asked for their quarter, and they would not notice until the figures
 * failed to reconcile. This runs the same query the page ran, without the
 * pagination, so the file is the whole filtered set.
 *
 * It takes the same query parameters the transactions page reads, so
 * `/transactions?from=…&source=stripe` and its export button return the same
 * rows in the same order.
 *
 * WHY CSV AND NOT XLSX. Excel, Numbers and Sheets all open CSV directly, and a
 * real .xlsx would mean a spreadsheet-writing dependency for no gain. Two
 * details make it open cleanly rather than as mangled text:
 *
 *   - a UTF-8 byte-order mark, without which Excel on Windows renders
 *     "Nguyễn" as "Nguyá»…n";
 *   - amounts as plain signed decimals with no currency symbol or thousands
 *     separator, so a spreadsheet reads them as numbers and can sum them.
 *
 * RLS still decides what is in the file: this uses the caller's own session,
 * not the service role, so an export cannot return a row the person could not
 * already see on the page.
 */

/** RFC 4180: quote when needed, and double any quote inside. */
function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  // A leading =, +, - or @ makes Excel treat the cell as a formula. A supplier
  // named "=SUM(A1)" is a spreadsheet injection; prefixing with an apostrophe
  // keeps it text.
  //
  // NEGATIVE NUMBERS ARE NOT AN ATTACK. The first version guarded on the
  // leading character alone, so every outflow arrived as '-403.37 — text, in a
  // column whose whole purpose is to be summed. Found by exporting the real
  // ledger and adding the column up: it came to nothing at all.
  const isNumber = /^-?\d+(\.\d+)?$/.test(text);
  const safe = !isNumber && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /["\n\r,]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const COLUMNS = [
  'Date',
  'Posted at',
  'Counterparty',
  'Description',
  'Category',
  'Subcategory',
  'Account',
  'Currency',
  'Amount',
  'Amount in USD',
  'Direction',
  'Source',
  'Internal transfer',
  'Status',
  'Transaction id',
] as const;

export async function GET(request: Request) {
  const tooMany = rateLimitRefusal(callerKey(request, 'txn-export'), { limit: 20, windowMs: 60 * 60_000 });
  if (tooMany) return tooMany;

  const auth = await requireApiSession({ capability: 'see_all_money' });
  if ('response' in auth) return auth.response;

  const params = new URL(request.url).searchParams;
  const str = (key: string) => params.get(key)?.trim() || undefined;

  const filters: TransactionFilters = {
    direction: str('direction') as TransactionFilters['direction'],
    accountId: str('account'),
    category: str('category'),
    status: str('status'),
    from: str('from'),
    to: str('to'),
    search: str('q'),
    operatingOnly: str('operating') === '1',
    uncategorized: str('uncategorized') === '1',
    source: str('source'),
    projectId: str('project'),
    unassigned: str('unassigned') === '1',
    excludeDemo: str('real') === '1',
    limit: Math.min(MAX_ROWS, Number(str('limit') ?? MAX_ROWS) || MAX_ROWS),
  };

  const db = createSupabaseServerClient();
  const { rows } = await loadTransactions(db, filters);

  const lines = [COLUMNS.map(csvCell).join(',')];
  for (const t of rows) {
    const sign = t.direction === 'outflow' ? -1 : 1;
    const currency = (t.currency || 'USD').toUpperCase();
    lines.push(
      [
        t.txn_date,
        t.posted_at ?? '',
        t.counterparty?.name ?? '',
        t.description ?? '',
        categoryLabel(t.category),
        t.subcategory ?? '',
        t.account?.name ?? '',
        currency,
        (sign * toMajor(t.amount_minor, currency)).toFixed(currency === 'VND' ? 0 : 2),
        t.amount_usd_minor === null ? '' : (sign * toMajor(t.amount_usd_minor, 'USD')).toFixed(2),
        t.direction,
        t.source_system,
        t.is_internal_transfer ? 'yes' : 'no',
        t.reconciliation_status ?? '',
        t.id,
      ]
        .map(csvCell)
        .join(','),
    );
  }

  const range = filters.from || filters.to ? `-${filters.from ?? 'start'}-to-${filters.to ?? today()}` : '';
  const filename = `my-cash-pilot-transactions${range}-${today()}.csv`;

  // \r\n line endings and the BOM are what make Excel open this without a
  // wizard. ﻿ first, or the first header cell arrives as "ï»¿Date".
  return new Response('﻿' + lines.join('\r\n') + '\r\n', {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
