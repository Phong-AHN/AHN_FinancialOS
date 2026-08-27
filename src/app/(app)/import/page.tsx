import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireOwner } from '@/lib/auth';
import { CsvImporter } from '@/components/CsvImporter';
import { NewAccountForm } from '@/components/NewAccountForm';
import { formatDateTime } from '@/lib/dates';
import type { Company, FinancialAccount, ManualImport } from '@/lib/types';
import { Callout, Card, EmptyState, PageHeader, SectionHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * CSV import - MVP Plan Day 1 (the module) and Day 6 (real VN bank, VEEM and
 * payroll files).
 *
 * These three sources have no self-serve API, so this page is how the
 * Vietnamese and Philippine side of AHN money reaches the same dashboard as the
 * API-connected US side. Without it the cash figure would only ever be partial.
 */
export default async function ImportPage() {
  await requireOwner();
  const supabase = createSupabaseServerClient();

  const [accountsRes, companiesRes, importsRes] = await Promise.all([
    supabase.from('financial_accounts').select('*').eq('is_active', true).order('name'),
    supabase.from('companies').select('*').order('name'),
    supabase.from('manual_imports').select('*').order('imported_at', { ascending: false }).limit(15),
  ]);

  const accounts = (accountsRes.data ?? []) as FinancialAccount[];
  const companies = (companiesRes.data ?? []) as Company[];
  const imports = (importsRes.data ?? []) as ManualImport[];

  return (
    <>
      <PageHeader
        title="Import a statement"
        subtitle="Vietnamese banks, VEEM and payroll have no self-serve API — this is how their dollars reach the dashboard."
      />

      <div className="mb-6">
        <Callout tone="brand" title="Same table, same totals">
          Imported rows land in exactly the same <code>transactions</code> table as QuickBooks,
          Plaid and Stripe, and flow through the same categorisation, alerting and duplicate
          detection. When VEEM or a VN bank eventually grants API access, only the ingestion
          changes — nothing on the dashboard has to be rebuilt.
        </Callout>
      </div>

      {accounts.length === 0 ? (
        <Card className="mb-6">
          <SectionHeader
            title="Create an account first"
            subtitle="A statement has to be imported into an account. Create the one this file belongs to."
          />
          <NewAccountForm companies={companies} />
        </Card>
      ) : (
        <CsvImporter accounts={accounts} canImport />
      )}

      {accounts.length > 0 && (
        <details className="mt-4">
          <summary className="muted cursor-pointer text-[13px]">
            Need a new account for this statement?
          </summary>
          <div className="mt-3">
            <Card>
              <NewAccountForm companies={companies} />
            </Card>
          </div>
        </details>
      )}

      <div className="mt-6">
        <Card padded={false}>
          <div className="p-5 pb-0">
            <SectionHeader title="Import history" subtitle="Every file, who loaded it, and what it produced." />
          </div>
          {imports.length === 0 ? (
            <EmptyState title="Nothing imported yet" body="Imported files are logged here with their row counts." />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>File</th>
                  <th>Source</th>
                  <th className="text-right">Rows</th>
                  <th className="text-right">Imported</th>
                  <th className="text-right">Skipped</th>
                </tr>
              </thead>
              <tbody>
                {imports.map((imp) => (
                  <tr key={imp.id}>
                    <td className="muted whitespace-nowrap">{formatDateTime(imp.imported_at)}</td>
                    <td className="font-medium">{imp.file_name}</td>
                    <td className="muted capitalize">{imp.source_label.replace(/_/g, ' ')}</td>
                    <td className="tabular text-right">{imp.row_count}</td>
                    <td className="tabular text-right">
                      <Link
                        href={`/transactions?q=${encodeURIComponent(imp.file_name)}`}
                        className="underline underline-offset-2"
                      >
                        {imp.inserted_count}
                      </Link>
                    </td>
                    <td className="tabular text-right muted">{imp.skipped_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
