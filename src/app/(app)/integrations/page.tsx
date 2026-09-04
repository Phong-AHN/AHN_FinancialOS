import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireOwner } from '@/lib/auth';
import { qboConfigProblems, qboConfigured, qboEnvironment } from '@/lib/connectors/quickbooks';
import { plaidConfigProblems, plaidConfigured, plaidEnvironment } from '@/lib/connectors/plaid';
import {
  finverseConfigProblems,
  finverseConfigured,
  finverseEnvironment,
} from '@/lib/connectors/finverse';
import {
  vietinbankConfigProblems,
  vietinbankConfigured,
  vietinbankEnvironment,
} from '@/lib/connectors/vietinbank';
import { veemConfigProblems, veemConfigured } from '@/lib/connectors/veem';
import { stripeConfigProblems, stripeConfigured, stripeMode } from '@/lib/connectors/stripe';
import { formatDateTime, relativeTime } from '@/lib/dates';
import { PlaidLinkButton } from '@/components/PlaidLinkButton';
import { EnableStripeButton } from '@/components/EnableStripeButton';
import { SyncButton } from '@/components/SyncButton';
import type { Integration } from '@/lib/types';
import { Badge, Callout, Card, LinkButton, PageHeader, SectionHeader, buttonClass } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface ProviderMeta {
  key: 'quickbooks' | 'plaid' | 'stripe' | 'finverse' | 'vietinbank' | 'veem';
  name: string;
  role: string;
  detail: string;
  envReady: boolean;
  /** Whether the keys themselves are present, regardless of other problems. */
  hasCredentials: boolean;
  /** Exactly what is wrong, so the card never says "missing" for six causes. */
  problems: string[];
}

/**
 * The sources whose row counts this page reports.
 *
 * Typed as the provider keys the cards actually look up, so adding a card
 * without counting its rows - or counting a source no card displays - is a
 * compile error rather than a silently empty figure.
 */
const COUNTED_SOURCES: ReadonlyArray<ProviderMeta['key']> = [
  'quickbooks',
  'plaid',
  'stripe',
  'finverse',
];


/**
 * Integrations - MVP Plan Days 2 and 3.
 *
 * Three providers self-serve their way to production credentials, so all three
 * are real API connections in week 1. Vietnamese banks, VEEM and payroll cannot
 * (no self-serve API programme exists for them), which is why they appear here
 * as a CSV route rather than a connect button.
 */
export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  // The owner check and the query start together. `requireOwner()` costs a
  // round trip to Tokyo, and gating the query behind it added that to every
  // load. A viewer who reaches here still gets redirected before anything
  // renders, and RLS decides what the query returns either way - so the check
  // still decides the outcome, it just no longer decides the timing.
  const supabase = createSupabaseServerClient();

  // How many REAL rows each provider has produced. Demo-seed rows are keyed
  // `demo-%`, and counting them here would tell someone their integration is
  // working when it has not synced a thing.
  //
  // Counted in Postgres, one `head` request per provider, all in flight at
  // once. This used to pull up to 20,000 `source_system` values across the
  // wire and tally them in JavaScript - invisible at 135 transactions, a
  // whole table transfer on every page view once the ledger is real.
  const [, integrationsRes, ...counts] = await Promise.all([
    requireOwner(),
    supabase
      .from('integrations')
      .select('id,provider,label,status,external_id,last_synced_at,last_error,created_at')
      .order('created_at'),
    ...COUNTED_SOURCES.map((source) =>
      supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .eq('source_system', source)
        .not('external_txn_id', 'like', 'demo-%'),
    ),
  ]);

  const integrations = (integrationsRes.data ?? []) as Array<
    Pick<Integration, 'id' | 'provider' | 'label' | 'status' | 'external_id' | 'last_synced_at' | 'last_error' | 'created_at'>
  >;

  const rowCounts = new Map<string, number>(
    COUNTED_SOURCES.map((source, i) => [source, counts[i]?.count ?? 0]),
  );

  const qboProblems = qboConfigProblems();
  const qboEnv = qboEnvironment();
  const plaidProblems = plaidConfigProblems();
  const plaidEnv = plaidEnvironment();
  const stripeProblems = stripeConfigProblems();
  const finverseProblems = finverseConfigProblems();
  const vtbProblems = vietinbankConfigProblems();
  const veemProblems = veemConfigProblems();

  const providers: ProviderMeta[] = [
    {
      key: 'quickbooks',
      name: 'QuickBooks Online',
      role: 'Accounting source of truth',
      detail:
        'Pulls cash-affecting entries — purchases, deposits, payments and bill payments. Invoices and bills are accruals and belong to the AR/AP module, not to cash.',
      envReady: qboConfigured() && qboProblems.length === 0,
      hasCredentials: qboConfigured(),
      problems: qboProblems,
    },
    {
      key: 'vietinbank',
      name: `VietinBank iConnect (${vietinbankEnvironment()})`,
      role: 'Vietnamese bank, direct',
      detail:
        'The corporate ERP Statement API, written against the bank’s own OpenAPI document. This is the route that reaches AHN’s money — Finverse lists VietinBank and Techcombank as INDIVIDUAL accounts only. Authentication is two apiKey headers rather than OAuth2, and one call returns a whole statement for one account and date range.',
      envReady: vietinbankConfigured() && vtbProblems.length === 0,
      hasCredentials: vietinbankConfigured(),
      problems: vtbProblems,
    },
    {
      key: 'veem',
      name: 'VEEM',
      role: 'Philippines payroll and cross-border payments',
      detail:
        'Client-credentials OAuth against api.veem.com — no redirect flow, nothing to click. Only a payment VEEM reports as Complete is treated as cash; anything still in flight becomes a commitment on Owed & owing, because money VEEM has accepted has not yet left the bank. VEEM’s documented sandbox serves a sign-in page rather than an API, so the first real call is against production.',
      envReady: veemConfigured() && veemProblems.length === 0,
      hasCredentials: veemConfigured(),
      problems: veemProblems,
    },
    {
      key: 'finverse',
      name: `Finverse (${finverseEnvironment()})`,
      role: 'Vietnamese bank accounts',
      detail:
        'The only route to a Vietnamese bank today: VietinBank\u2019s sandbox needs a registered application and Techcombank has no public one at all. Finverse already covers Techcombank, Vietcombank and VP Bank. The bank sign-in happens on their page \u2014 AHN\u2019s bank credentials never reach this system.',
      envReady: finverseConfigured() && finverseProblems.length === 0,
      hasCredentials: finverseConfigured(),
      problems: finverseProblems,
    },
    {
      key: 'plaid',
      name: 'Plaid',
      role: 'US bank accounts and cards',
      detail:
        'Cursor-based transaction sync plus live balances. Pending transactions are skipped until they post, so nothing is alerted that later disappears.',
      envReady: plaidConfigured() && plaidProblems.length === 0,
      hasCredentials: plaidConfigured(),
      problems: plaidProblems,
    },
    {
      key: 'stripe',
      name: 'Stripe',
      role: 'Payment processing',
      detail:
        'Reads balance transactions, so processing fees show as their own expense line instead of hiding inside gross revenue. Payouts are booked as internal transfers.',
      envReady: stripeConfigured() && stripeProblems.length === 0,
      hasCredentials: stripeConfigured(),
      problems: stripeProblems,
    },
  ];

  return (
    <>
      <PageHeader
        title="Integrations"
        subtitle="Where the dollars come from. Each source writes into the same transactions table."
        action={<SyncButton />}
      />

      {searchParams.connected && (
        <div className="mb-6">
          <Callout tone="brand" title={`${searchParams.connected} connected`}>
            The first sync pulls roughly six months of history, so it may take a minute. Alerts fire
            for anything new from here on.
          </Callout>
        </div>
      )}
      {searchParams.error && (
        <div className="mb-6">
          <Callout tone="outflow" title="Connection failed">
            {searchParams.error}
          </Callout>
        </div>
      )}

      <div className="grid gap-4">
        {providers.map((provider) => {
          const connected = integrations.filter((i) => i.provider === provider.key);
          return (
            <Card key={provider.key}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="max-w-[620px]">
                  <div className="flex items-center gap-2.5">
                    <h3 className="text-[15px] font-semibold">{provider.name}</h3>
                    {connected.some((c) => c.status === 'connected') ? (
                      <Badge tone="inflow">Connected</Badge>
                    ) : connected.some((c) => c.status === 'error') ? (
                      <Badge tone="outflow">Error</Badge>
                    ) : provider.envReady ? (
                      <Badge tone="brand">Ready to connect</Badge>
                    ) : provider.hasCredentials ? (
                      // Credentials present but something else is wrong. Saying
                      // "missing" here sends someone hunting for a key that is
                      // already there.
                      <Badge tone="warn">Check configuration</Badge>
                    ) : (
                      <Badge tone="warn">Credentials missing</Badge>
                    )}
                  </div>
                  <p className="faint mt-0.5 text-[11.5px] uppercase tracking-wide">{provider.role}</p>
                  <p className="muted mt-2 text-[13px] leading-relaxed">{provider.detail}</p>
                  {provider.problems.length > 0 && (
                    <ul className="mt-2 space-y-1 text-[12px]" style={{ color: 'var(--warn)' }}>
                      {provider.problems.map((problem) => (
                        <li key={problem}>· {problem}</li>
                      ))}
                    </ul>
                  )}
                                    {provider.key === 'plaid' && plaidConfigured() && plaidEnv.valid && (
                    <p
                      className="mt-2 text-[12px]"
                      style={{ color: plaidEnv.isSimulated ? 'var(--warn)' : 'var(--text-faint)' }}
                    >
                      {plaidEnv.isSimulated
                        ? 'Sandbox: banks and transactions are simulated. Nothing here is AHN real money. Sign in at the bank prompt with user_good / pass_good.'
                        : 'Production: connects real bank accounts.'}
                    </p>
                  )}
                  {provider.key === 'stripe' && stripeConfigured() && stripeProblems.length === 0 && (
                    <p
                      className="mt-2 text-[12px]"
                      style={{ color: stripeMode() === 'live' ? 'var(--text-faint)' : 'var(--warn)' }}
                    >
                      {stripeMode() === 'live'
                        ? 'Live key: reads the real Stripe balance and payouts.'
                        : `${stripeMode()} key: the balance and history it returns are fabricated test data, not AHN money.`}
                    </p>
                  )}
                  {provider.key === 'quickbooks' && qboConfigured() && qboEnv.valid && (
                    <p className="faint mt-2 text-[12px]">
                      Targeting the <strong>{qboEnv.environment}</strong> Intuit API. Credentials
                      must come from that same environment, and{' '}
                      <code>{process.env.QBO_REDIRECT_URI ?? 'the redirect URI'}</code> must be
                      registered on the Intuit app.
                    </p>
                  )}
                </div>

                <div className="shrink-0">
                  {provider.key === 'quickbooks' && (
                    <a
                      href="/api/integrations/quickbooks/connect"
                      className={buttonClass(provider.envReady ? 'primary' : 'secondary')}
                      aria-disabled={!provider.envReady}
                    >
                      {connected.length ? 'Reconnect QuickBooks' : 'Connect QuickBooks'}
                    </a>
                  )}
                  {provider.key === 'plaid' && <PlaidLinkButton ready={provider.envReady} />}
                  {provider.key === 'stripe' && (
                    <EnableStripeButton ready={provider.envReady} alreadyEnabled={connected.length > 0} />
                  )}
                </div>
              </div>

              <div className="mt-3 border-t border-[var(--line)] pt-3 text-[12.5px]">
                {rowCounts.get(provider.key) ? (
                  <Link
                    href={`/transactions?source=${provider.key}&real=1`}
                    className="underline underline-offset-2"
                  >
                    {rowCounts.get(provider.key)!.toLocaleString('en-US')} real transactions from
                    this source →
                  </Link>
                ) : (
                  <span className="faint">
                    No real transactions from this source yet
                    {connected.length ? ' — the last sync returned nothing new.' : '.'}
                  </span>
                )}
              </div>

              {connected.length > 0 && (
                <div className="mt-4 border-t border-[var(--line)] pt-3">
                  {connected.map((c) => (
                    <div key={c.id} className="flex flex-wrap items-baseline justify-between gap-3 py-1 text-[12.5px]">
                      <span className="muted">
                        {c.label ?? c.external_id ?? 'connection'}{' '}
                        <span className="faint">· added {formatDateTime(c.created_at)}</span>
                      </span>
                      <span className="faint">
                        {c.last_synced_at ? `Last synced ${relativeTime(c.last_synced_at)}` : 'Never synced'}
                      </span>
                      {c.last_error && (
                        <span className="w-full text-[12px]" style={{ color: 'var(--outflow)' }}>
                          {c.last_error}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          );
        })}

        {/* ── The sources with no self-serve API ────────────────────────── */}
        <Card>
          <SectionHeader
            title="Vietnamese banks · VEEM · payroll"
            subtitle="No self-serve API exists for these, so week 1 brings them in by file."
            action={<LinkButton href="/import" variant="primary">Import a statement</LinkButton>}
          />
          <p className="muted text-[13px] leading-relaxed">
            Vietnamese banks grant API access only under a corporate-banking agreement, and VEEM
            routes API access through a partner sales process — neither is obtainable inside a
            sprint. Imported rows are identical to API rows once they land: same table, same
            categorisation, same alerts, same duplicate detection. When either relationship is in
            place, swapping the ingestion path in touches one file and changes nothing downstream.
          </p>
        </Card>
      </div>

      <Card className="mt-4">
        <SectionHeader title="After changing credentials" />
        <p className="muted text-[13px] leading-relaxed">
          Environment variables are read once, when the server process starts. Editing{' '}
          <code>.env.local</code> while the app is running changes nothing until it is restarted —
          a card here will keep reporting credentials as missing even though the file is correct.
          Stop the dev server and start it again after any change.
        </p>
      </Card>

      <Card className="mt-4">
        <SectionHeader title="Automatic syncing" />
        <p className="muted text-[13px] leading-relaxed">
          A scheduler calls <code>/api/cron/sync</code> every 10 minutes, plus a daily digest and a
          weekly one. Each run pulls new transactions, re-checks for cross-source duplicates, fires
          alerts for anything unseen, and evaluates the runway and balance thresholds. The route is
          guarded by <code>CRON_SECRET</code>, so nothing runs without it.
        </p>
        <p className="muted mt-2 text-[13px] leading-relaxed">
          The schedule runs as a separate worker rather than on Vercel, whose Hobby plan allows
          only one cron run per day. Its <code>/health</code> endpoint reports the last outcome of
          every job and answers 503 once any has failed — worth checking if transactions stop
          appearing.
        </p>
      </Card>
    </>
  );
}
