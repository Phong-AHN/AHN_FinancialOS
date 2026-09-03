import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireSession, sessionCan } from '@/lib/auth';
import { loadDashboard } from '@/lib/data';
import { loadRateStatus, missingRates } from '@/lib/fx';
import { RateEditor } from '@/components/RateEditor';
import { formatMoney, formatPercent } from '@/lib/money';
import { formatDateTime, today } from '@/lib/dates';
import type { Company } from '@/lib/types';
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

const COUNTRY_LABELS: Record<string, string> = {
  US: 'United States',
  VN: 'Vietnam',
  PH: 'Philippines',
  OTHER: 'Other',
};

/**
 * Cash by account, entity and currency - Spec section 9 and section 21.
 *
 * The variance column is the point of this page. It compares what the bank says
 * the balance is against what our own transactions add up to. Spec section 28
 * requires cash to reconcile with connected accounts, and the honest way to
 * prove that is to show the difference rather than to display only one of them.
 */
export default async function AccountsPage() {
  // The session check and the data query start together. `requireSession()`
  // costs a round trip to the Auth server in Tokyo, and running it first meant
  // every page waited for it before asking for a single row. RLS is the real
  // boundary - a request without a valid session gets nothing back from these
  // queries anyway - and `redirect()` throws before anything renders, so a
  // signed-out visitor still sees the login screen and never sees data.
  const supabase = createSupabaseServerClient();
  const asOf = today();

  const [session, { snapshot, accounts, rates }, companiesRes, rateStatus] = await Promise.all([
    requireSession(),
    loadDashboard(supabase, asOf),
    supabase.from('companies').select('*'),
    loadRateStatus(supabase, asOf),
  ]);
  const canEdit = sessionCan(session, 'move_money');

  const companies = (companiesRes.data ?? []) as Company[];
  const companyName = (id: string) => companies.find((c) => c.id === id)?.name ?? 'Unknown entity';
  const { cash } = snapshot;

  // Spec §9 asks for cash by country, not only by entity. An entity name does
  // not tell a reader which jurisdiction the money is sitting in.
  const countryTotals = new Map<string, { totalUsdMinor: number; accounts: number }>();
  for (const b of cash.byAccount) {
    if (!b.account.include_in_cash) continue;
    const country = companies.find((c) => c.id === b.account.company_id)?.entity_country ?? 'OTHER';
    const entry = countryTotals.get(country) ?? { totalUsdMinor: 0, accounts: 0 };
    entry.totalUsdMinor += b.balanceUsdMinor;
    entry.accounts += 1;
    countryTotals.set(country, entry);
  }
  const byCountry = [...countryTotals]
    .map(([country, v]) => ({ country, ...v }))
    .sort((a, b) => b.totalUsdMinor - a.totalUsdMinor);

  const unpricedCurrencies = missingRates(
    accounts.map((a) => a.currency),
    rates,
  );
  const withVariance = cash.byAccount.filter((b) => b.varianceMinor !== null && b.varianceMinor !== 0);

  // Every non-USD currency actually held, whether or not it has a rate. A
  // currency with a rate still needs to be visible: a stale rate converts every
  // balance in it silently, and nothing else on the page would show that.
  //
  // Currencies that are priced but not yet held are listed too. The daily feed
  // fetches VND from the day it is switched on, and seeing that rate arrive —
  // dated, sourced, current — is how anyone knows the feed works before the
  // first dong is imported rather than the morning after.
  const foreignCurrencies = [
    ...new Set([
      ...accounts
        .filter((a) => a.is_active)
        .map((a) => a.currency.toUpperCase())
        .filter((c) => c !== 'USD'),
      ...rateStatus.map((r) => r.currency),
    ]),
  ].sort();

  const heldCurrencies = new Set(
    accounts.filter((a) => a.is_active).map((a) => a.currency.toUpperCase()),
  );
  const staleRates = rateStatus.filter((r) => r.ageDays > 7 && heldCurrencies.has(r.currency));

  return (
    <>
      <PageHeader
        title="Accounts"
        subtitle="Every account, what it holds, and whether our records agree with the provider."
        action={<LinkButton href="/import">Import a statement</LinkButton>}
      />

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <StatTile
          label="Total cash"
          value={formatMoney(cash.totalUsdMinor)}
          hint={`${cash.byAccount.filter((b) => b.account.include_in_cash).length} accounts counted`}
          emphasis
        />
        <StatTile
          label="Held for duplicate review"
          value={formatMoney(cash.heldForReviewUsdMinor)}
          hint="Excluded from the total above"
          href="/reconcile"
          tone={cash.heldForReviewUsdMinor > 0 ? 'warn' : 'neutral'}
        />
        <StatTile
          label="Accounts out of balance"
          value={String(cash.unreconciledAccounts)}
          hint="Provider balance differs from our transactions"
          href="/reconcile"
          tone={cash.unreconciledAccounts > 0 ? 'warn' : 'inflow'}
        />
      </div>

      {unpricedCurrencies.length > 0 && (
        <div className="mb-6">
          <Callout tone="warn" title="Missing exchange rate">
            No USD rate on file for {unpricedCurrencies.join(', ')}. Those balances are counted as
            zero in the USD total rather than being treated 1:1 — understating is recoverable, a
            25,000× overstatement in a runway figure is not. Set a rate below to include them.
          </Callout>
        </div>
      )}

      {foreignCurrencies.length > 0 && (
        <div className="mb-6">
          <Card>
            <SectionHeader
              title="Exchange rates"
              subtitle="Refreshed daily from Vietcombank, an hour before the morning digest. A rate set by hand is never overwritten."
            />
            <ul className="divide-y divide-[var(--line)]">
              {foreignCurrencies.map((currency) => (
                <li key={currency} className="py-3 first:pt-0 last:pb-0">
                  <RateEditor
                    currency={currency}
                    currentRate={rates[currency] ?? null}
                    asOf={asOf}
                    canEdit={canEdit}
                    provenance={rateStatus.find((r) => r.currency === currency) ?? null}
                  />
                  {!heldCurrencies.has(currency) && (
                    <p className="faint mt-1 text-[11px]">
                      Priced daily, though no active account holds {currency} yet.
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {staleRates.length > 0 && (
        <div className="mb-6">
          <Callout tone="warn" title="An exchange rate has stopped updating">
            The rate for {staleRates.map((r) => r.currency).join(', ')} is more than a week old, and
            every balance in it is still being converted by that number. Either the daily feed is
            failing or a hand-set rate is standing in its way — check the worker&rsquo;s health
            endpoint.
          </Callout>
        </div>
      )}

      {withVariance.length > 0 && (
        <div className="mb-6">
          <Callout tone="warn" title={`${withVariance.length} account${withVariance.length > 1 ? 's' : ''} do not reconcile`}>
            The provider-reported balance and the sum of the transactions we hold disagree. Usually
            this means the account has history older than our first sync, or an opening balance that
            has not been set.
          </Callout>
        </div>
      )}

      {/* ── By currency ───────────────────────────────────────────────────── */}
      {cash.byCurrency.length > 1 && (
        <Card className="mb-4">
          <SectionHeader title="By currency" subtitle="Converted at the most recent rate on or before today." />
          <div className="flex flex-wrap gap-6">
            {cash.byCurrency.map((c) => (
              <div key={c.currency}>
                <p className="faint text-[11px] font-semibold uppercase tracking-wide">{c.currency}</p>
                <p className="tabular mt-1 text-[18px] font-semibold">
                  {formatMoney(c.totalMinor, c.currency)}
                </p>
                <p className="faint text-[11.5px]">= {formatMoney(c.totalUsdMinor)}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── By country (spec §9: cash by account/entity/country) ──────────── */}
      {byCountry.length > 1 && (
        <Card className="mb-4">
          <SectionHeader
            title="By country"
            subtitle="Where the money physically sits, which is what matters when it has to move."
          />
          <div className="flex flex-wrap gap-8">
            {byCountry.map((c) => (
              <div key={c.country}>
                <p className="faint text-[11px] font-semibold uppercase tracking-wide">
                  {COUNTRY_LABELS[c.country] ?? c.country}
                </p>
                <p className="tabular mt-1 text-[18px] font-semibold">{formatMoney(c.totalUsdMinor)}</p>
                <p className="faint text-[11.5px]">
                  {c.accounts} account{c.accounts === 1 ? '' : 's'} ·{' '}
                  {formatPercent(cash.totalUsdMinor === 0 ? null : c.totalUsdMinor / cash.totalUsdMinor, 0)} of cash
                </p>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── By entity ─────────────────────────────────────────────────────── */}
      {companies.length > 1 && (
        <Card className="mb-4">
          <SectionHeader title="By entity" />
          <div className="flex flex-wrap gap-8">
            {cash.byCompany.map((c) => (
              <div key={c.companyId}>
                <p className="faint text-[11px] font-semibold uppercase tracking-wide">
                  {companyName(c.companyId)}
                </p>
                <p className="tabular mt-1 text-[18px] font-semibold">{formatMoney(c.totalUsdMinor)}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── The accounts themselves ───────────────────────────────────────── */}
      <Card padded={false}>
        {cash.byAccount.length === 0 ? (
          <EmptyState
            title="No accounts yet"
            body="Connect QuickBooks, Plaid or Stripe on the Integrations page, or import a CSV statement."
            action={<LinkButton href="/integrations" variant="primary">Connect a source</LinkButton>}
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Entity</th>
                <th>Type</th>
                <th>Source</th>
                <th className="text-right">Provider says</th>
                <th className="text-right">Our records</th>
                <th className="text-right">Variance</th>
                <th className="text-right">In USD</th>
              </tr>
            </thead>
            <tbody>
              {cash.byAccount.map((b) => (
                <tr key={b.account.id}>
                  <td>
                    <Link href={`/transactions?account=${b.account.id}`} className="font-medium hover:underline">
                      {b.account.name}
                    </Link>
                    {b.account.mask && <span className="faint ml-1.5 text-[11.5px]">••{b.account.mask}</span>}
                    <span className="mt-1 flex gap-1.5">
                      {!b.account.include_in_cash && <Badge>Not counted as cash</Badge>}
                      {!b.account.is_active && <Badge tone="warn">Inactive</Badge>}
                    </span>
                    {b.account.reported_balance_at && (
                      <span className="faint mt-0.5 block text-[11px]">
                        Balance as of {formatDateTime(b.account.reported_balance_at)}
                      </span>
                    )}
                  </td>
                  <td className="muted">{companyName(b.account.company_id)}</td>
                  <td className="muted capitalize">{b.account.type.replace(/_/g, ' ')}</td>
                  <td className="muted capitalize">{b.account.source_system.replace(/_/g, ' ')}</td>
                  <td className="tabular text-right">
                    {b.reportedMinor === null ? (
                      <span className="faint">—</span>
                    ) : (
                      formatMoney(b.reportedMinor, b.account.currency)
                    )}
                  </td>
                  <td className="tabular text-right muted">
                    {formatMoney(b.derivedMinor, b.account.currency)}
                  </td>
                  <td className="tabular text-right">
                    {b.varianceMinor === null ? (
                      <span className="faint">—</span>
                    ) : b.varianceMinor === 0 ? (
                      <Badge tone="inflow">Balanced</Badge>
                    ) : (
                      <Money minor={b.varianceMinor} currency={b.account.currency} signed />
                    )}
                  </td>
                  <td className="tabular text-right font-medium">{formatMoney(b.balanceUsdMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <FormulaNote>
        <strong>Our records</strong> = opening balance + every non-duplicate transaction on the
        account. <strong>Provider says</strong> = the balance the bank, QuickBooks or Stripe last
        reported. The headline cash figure uses the provider balance wherever one exists, since that
        is the money actually available; accounts with no provider feed fall back to our own sum.
      </FormulaNote>
    </>
  );
}
