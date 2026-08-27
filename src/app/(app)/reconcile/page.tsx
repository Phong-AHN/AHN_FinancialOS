import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth';
import { loadDashboard, loadTransactions } from '@/lib/data';
import { formatMoney } from '@/lib/money';
import { today } from '@/lib/dates';
import { categoryLabel } from '@/lib/categorize';
import { ReconcileActions } from '@/components/ReconcileActions';
import { RecategorizeButton } from '@/components/RecategorizeButton';
import {
  Badge,
  Callout,
  Card,
  EmptyState,
  FormulaNote,
  LinkButton,
  Money,
  PageHeader,
  SectionHeader,
  StatTile,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Data-quality queues - Spec section 22, MVP Plan Day 6.
 *
 * Three queues, in the order they damage the numbers:
 *   1. possible duplicates - actively held out of cash, so the total is
 *      understated until someone rules on them
 *   2. accounts out of balance - the provider and our records disagree
 *   3. missing categories - totals are right, attribution is not
 */
export default async function ReconcilePage() {
  // The session check and the data query start together. `requireSession()`
  // costs a round trip to the Auth server in Tokyo, and running it first meant
  // every page waited for it before asking for a single row. RLS is the real
  // boundary - a request without a valid session gets nothing back from these
  // queries anyway - and `redirect()` throws before anything renders, so a
  // signed-out visitor still sees the login screen and never sees data.
  const supabase = createSupabaseServerClient();
  const asOf = today();

  const [session, { snapshot }, duplicates, uncategorized] = await Promise.all([
    requireSession(),
    loadDashboard(supabase, asOf),
    loadTransactions(supabase, { status: 'possible_duplicate', limit: 50 }),
    loadTransactions(supabase, { uncategorized: true, limit: 50 }),
  ]);
  const canEdit = session.user.role === 'owner';

  const outOfBalance = snapshot.cash.byAccount.filter(
    (b) => b.varianceMinor !== null && b.varianceMinor !== 0,
  );

  const clean =
    duplicates.total === 0 && uncategorized.total === 0 && outOfBalance.length === 0;

  return (
    <>
      <PageHeader
        title="Reconcile"
        subtitle="Everything standing between the dashboard and a number you would sign your name to."
      />

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <StatTile
          label="Possible duplicates"
          value={String(duplicates.total)}
          hint={`${formatMoney(snapshot.cash.heldForReviewUsdMinor)} held out of cash`}
          tone={duplicates.total > 0 ? 'warn' : 'inflow'}
        />
        <StatTile
          label="Accounts out of balance"
          value={String(outOfBalance.length)}
          hint="Provider balance vs. our transactions"
          href="/accounts"
          tone={outOfBalance.length > 0 ? 'warn' : 'inflow'}
        />
        <StatTile
          label="Missing a category"
          value={String(uncategorized.total)}
          hint="Counted in totals, unattributed"
          href="/transactions?uncategorized=1"
          tone={uncategorized.total > 0 ? 'warn' : 'inflow'}
        />
      </div>

      {clean && (
        <div className="mb-6">
          <Callout tone="brand" title="Nothing to review">
            No suspected duplicates, every account reconciles, and every transaction has a category.
            The dashboard numbers are as clean as the source data allows.
          </Callout>
        </div>
      )}

      {/* ── 1. Duplicates ─────────────────────────────────────────────────── */}
      <Card padded={false} className="mb-4">
        <div className="p-5 pb-0">
          <SectionHeader
            title="Possible duplicates"
            subtitle="The same activity arriving from two sources. Held out of every total until ruled on."
          />
        </div>
        {duplicates.rows.length === 0 ? (
          <p className="faint px-5 pb-5 text-[13px]">
            Nothing flagged. Matching runs automatically after each sync across a 45-day window.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Transaction</th>
                <th>Source</th>
                <th>Why it was flagged</th>
                <th className="text-right">Amount</th>
                <th className="text-right">Decision</th>
              </tr>
            </thead>
            <tbody>
              {duplicates.rows.map((t) => (
                <tr key={t.id}>
                  <td className="tabular muted whitespace-nowrap">{t.txn_date}</td>
                  <td>
                    <Link href={`/transactions/${t.id}`} className="font-medium hover:underline">
                      {t.counterparty?.name ?? t.description ?? 'Unknown'}
                    </Link>
                    <span className="faint mt-0.5 block text-[11.5px]">{t.account?.name}</span>
                  </td>
                  <td className="muted capitalize">{t.source_system.replace(/_/g, ' ')}</td>
                  <td className="muted max-w-[300px] text-[12px] leading-snug">
                    {t.notes ?? 'Matched on amount, direction and date.'}
                    {t.duplicate_of_id && (
                      <Link
                        href={`/transactions/${t.duplicate_of_id}`}
                        className="mt-1 block underline underline-offset-2"
                      >
                        Compare with the kept record →
                      </Link>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <Money minor={t.amount_minor} currency={t.currency} direction={t.direction} />
                  </td>
                  <td className="text-right">
                    <ReconcileActions transactionId={t.id} canEdit={canEdit} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {duplicates.total > duplicates.rows.length && (
          <p className="faint px-5 pb-5 pt-3 text-[12px]">
            Showing {duplicates.rows.length} of {duplicates.total}.{' '}
            <Link href="/transactions?status=possible_duplicate" className="underline underline-offset-2">
              See all
            </Link>
          </p>
        )}
      </Card>

      {/* ── 2. Out-of-balance accounts ────────────────────────────────────── */}
      <Card padded={false} className="mb-4">
        <div className="p-5 pb-0">
          <SectionHeader
            title="Accounts that do not reconcile"
            subtitle="Provider-reported balance against the sum of the transactions we hold."
          />
        </div>
        {outOfBalance.length === 0 ? (
          <p className="faint px-5 pb-5 text-[13px]">Every account with a provider feed reconciles.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th className="text-right">Provider says</th>
                <th className="text-right">Our records</th>
                <th className="text-right">Difference</th>
                <th>Most likely cause</th>
              </tr>
            </thead>
            <tbody>
              {outOfBalance.map((b) => (
                <tr key={b.account.id}>
                  <td>
                    <Link href={`/transactions?account=${b.account.id}`} className="font-medium hover:underline">
                      {b.account.name}
                    </Link>
                  </td>
                  <td className="tabular text-right">
                    {formatMoney(b.reportedMinor, b.account.currency)}
                  </td>
                  <td className="tabular text-right muted">
                    {formatMoney(b.derivedMinor, b.account.currency)}
                  </td>
                  <td className="text-right">
                    <Money minor={b.varianceMinor} currency={b.account.currency} signed />
                  </td>
                  <td className="muted max-w-[320px] text-[12px] leading-snug">
                    {b.txnCount === 0
                      ? 'No transactions synced for this account yet.'
                      : 'History predating the first sync, or an opening balance that has not been set.'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <FormulaNote>
          Setting <code>opening_balance_minor</code> on an account to the difference above closes
          the gap without inventing transactions — the right move when the account had a balance
          before our first sync reached back.
        </FormulaNote>
      </Card>

      {/* ── 3. Missing categories ─────────────────────────────────────────── */}
      <Card padded={false}>
        <div className="p-5 pb-0">
          <SectionHeader
            title="Missing a category"
            subtitle="These count toward cash and burn correctly, but cannot be attributed to a cost area."
            action={
              <div className="flex items-center gap-2">
                <RecategorizeButton canEdit={canEdit} />
                {uncategorized.total > 0 && (
                  <LinkButton href="/transactions?uncategorized=1">Open in transactions</LinkButton>
                )}
              </div>
            }
          />
        </div>
        {uncategorized.rows.length === 0 ? (
          <p className="faint px-5 pb-5 text-[13px]">Everything is categorised.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Counterparty / description</th>
                <th>Account</th>
                <th>Current category</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {uncategorized.rows.slice(0, 25).map((t) => (
                <tr key={t.id}>
                  <td className="tabular muted whitespace-nowrap">{t.txn_date}</td>
                  <td>
                    <Link href={`/transactions/${t.id}`} className="font-medium hover:underline">
                      {t.counterparty?.name ?? t.description ?? 'Unknown'}
                    </Link>
                  </td>
                  <td className="muted">{t.account?.name ?? '—'}</td>
                  <td>
                    <Badge tone="warn">{categoryLabel(t.category)}</Badge>
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <Money minor={t.amount_minor} currency={t.currency} direction={t.direction} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {duplicates.total === 0 && uncategorized.total === 0 && outOfBalance.length === 0 && (
        <div className="mt-4">
          <EmptyState
            title="Queues are empty"
            body="New items appear here automatically after each sync or CSV import."
          />
        </div>
      )}
    </>
  );
}
