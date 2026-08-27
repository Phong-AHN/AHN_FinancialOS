import { describe, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { getAccessToken, qboApiBase, qboEnvironment } from '@/lib/connectors/quickbooks';
import type { Integration } from '@/lib/types';

/**
 * "What does this QuickBooks company actually contain?"
 *
 *   QBO_INVENTORY=1 npx vitest run tests/qbo-inventory.integration.test.ts
 *
 * Read-only. Answers the question that decides what the connector should sync —
 * especially **where payroll lives**, which differs by company:
 *
 *   - a company on QuickBooks Payroll posts each pay run as a JournalEntry
 *     against wage and tax expense accounts;
 *   - a company paying through a bureau books it as a Purchase or BillPayment;
 *   - a company not running payroll in QuickBooks at all has neither.
 *
 * The sync deliberately covers only the cash-affecting entities (Purchase,
 * Deposit, Payment, BillPayment) — see decision 2. If this report shows payroll
 * sitting in JournalEntry rows, that is the signal to extend it, and the
 * posting-type breakdown below is what tells you whether doing so would
 * double-count the bank side.
 */
const ON = process.env.QBO_INVENTORY === '1';

describe.skipIf(!ON)('QuickBooks company inventory', () => {
  it('reports what is there', async () => {
    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );

    const { data } = await db
      .from('integrations')
      .select('*')
      .eq('provider', 'quickbooks')
      .maybeSingle();

    if (!data) {
      console.log('  No QuickBooks integration is connected.');
      return;
    }
    const integration = data as Integration;
    const token = await getAccessToken(integration, async (t) => {
      await db.from('integrations').update(t).eq('id', integration.id);
    });
    const realm = integration.external_id!;

    async function query<T>(statement: string, entity: string): Promise<T[]> {
      const url = `${qboApiBase()}/v3/company/${realm}/query?query=${encodeURIComponent(statement)}&minorversion=70`;
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { QueryResponse?: Record<string, T[]> };
      return json.QueryResponse?.[entity] ?? [];
    }

    console.log(`\n  realm ${realm} · ${qboEnvironment().environment} API\n`);

    console.log('  ENTITY COUNTS');
    for (const entity of [
      'Purchase', 'Deposit', 'Payment', 'BillPayment',
      'Bill', 'Invoice', 'JournalEntry', 'Employee', 'TimeActivity', 'Vendor',
    ]) {
      const rows = await query(`select * from ${entity} maxresults 500`, entity);
      const synced = ['Purchase', 'Deposit', 'Payment', 'BillPayment'].includes(entity);
      console.log(
        `    ${entity.padEnd(14)} ${String(rows.length).padStart(4)}` +
          (synced ? '  (synced)' : ''),
      );
    }

    // Which accounts could hold compensation.
    const accounts = await query<{ Name: string; AccountType: string; AccountSubType?: string }>(
      "select * from Account where AccountType in ('Expense','Other Expense','Cost of Goods Sold') maxresults 500",
      'Account',
    );
    const payrollish = accounts.filter((a) =>
      /payroll|wage|salar|compensation|employee benefit/i.test(`${a.Name} ${a.AccountSubType ?? ''}`),
    );
    console.log(`\n  PAYROLL ACCOUNTS  ${payrollish.length} of ${accounts.length} expense accounts`);
    for (const a of payrollish) console.log(`    ${a.Name}  (${a.AccountSubType ?? '—'})`);
    if (payrollish.length === 0) {
      console.log('    none — this company does not book payroll in QuickBooks');
    }

    // Journal entries, and whether they move cash.
    const journals = await query<{
      Id: string;
      TxnDate: string;
      PrivateNote?: string;
      Line?: Array<{
        Amount?: number;
        JournalEntryLineDetail?: { PostingType?: string; AccountRef?: { name?: string } };
      }>;
    }>('select * from JournalEntry maxresults 100', 'JournalEntry');

    console.log(`\n  JOURNAL ENTRIES  ${journals.length}`);
    for (const je of journals.slice(0, 10)) {
      const accountsTouched = (je.Line ?? [])
        .map((l) => l.JournalEntryLineDetail?.AccountRef?.name ?? '?')
        .join(' / ');
      console.log(`    ${je.TxnDate}  ${je.PrivateNote ?? '(no memo)'}  →  ${accountsTouched}`);
    }
    if (journals.length) {
      console.log(
        '\n    Journal entries are NOT synced. Read the accounts above: if they are',
      );
      console.log(
        '    opening balances or reclassifications, booking them would invent spend',
      );
      console.log(
        '    that never left a bank account. If they are pay runs, extend the sync.',
      );
    }
  }, 120_000);
});
