/**
 * Sync orchestration - the layer the cron route and the "Sync now" button both
 * call. One entry point per provider, all funnelling into `ingestTransactions`.
 *
 * Design rule: a failure in one provider must not stop the others. If Plaid is
 * down, the QuickBooks pull still runs and the CEO still gets alerts for the
 * dollars we can see. Each provider result carries its own error string.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { FinancialAccount, Integration, SyncResult } from '@/lib/types';
import { addDays, today, type ISODate } from '@/lib/dates';
import { ingestTransactions } from '@/lib/ingest';
import { decryptSecret, encryptSecret } from '@/lib/crypto';
import {
  fetchQboAccounts,
  fetchQboTransactions,
  getAccessToken,
  qboConfigured,
} from '@/lib/connectors/quickbooks';
import {
  fetchAccounts as fetchPlaidAccounts,
  mapAccountType,
  plaidConfigured,
  syncTransactions as plaidSyncTransactions,
} from '@/lib/connectors/plaid';
import {
  fetchStripeBalance,
  fetchStripeTransactions,
  stripeConfigured,
} from '@/lib/connectors/stripe';
import { toMinor } from '@/lib/money';

/** How far back a first-time sync reaches. */
const INITIAL_LOOKBACK_DAYS = 180;
/** Overlap on incremental syncs, so a late-posting transaction is not missed. */
const INCREMENTAL_OVERLAP_DAYS = 7;

export async function ensureDefaultCompany(db: SupabaseClient): Promise<string> {
  const { data: existing } = await db.from('companies').select('id').limit(1).maybeSingle();
  if (existing) return (existing as { id: string }).id;

  const { data, error } = await db
    .from('companies')
    .insert({ name: 'Asian Hustle Network', entity_country: 'US', currency: 'USD' })
    .select('id')
    .single();
  if (error) throw new Error(`Could not create default company: ${error.message}`);
  return (data as { id: string }).id;
}

/**
 * Find or create the `financial_accounts` row for an external account. Keyed on
 * (source_system, external_account_id), so re-running a sync never forks a
 * second copy of the same bank account.
 */
async function upsertAccount(
  db: SupabaseClient,
  companyId: string,
  account: {
    external_account_id: string;
    name: string;
    type: string;
    currency: string;
    source_system: string;
    mask?: string | null;
    reported_balance_minor?: number | null;
    include_in_cash?: boolean;
  },
): Promise<FinancialAccount> {
  const { data: existing } = await db
    .from('financial_accounts')
    .select('*')
    .eq('source_system', account.source_system)
    .eq('external_account_id', account.external_account_id)
    .maybeSingle();

  if (existing) {
    // Refresh the balance and name, but never touch include_in_cash - the user
    // may have deliberately excluded this account from the cash total.
    if (account.reported_balance_minor !== undefined && account.reported_balance_minor !== null) {
      await db
        .from('financial_accounts')
        .update({
          reported_balance_minor: account.reported_balance_minor,
          reported_balance_at: new Date().toISOString(),
          name: account.name,
        })
        .eq('id', (existing as FinancialAccount).id);
    }
    return existing as FinancialAccount;
  }

  const { data, error } = await db
    .from('financial_accounts')
    .insert({
      company_id: companyId,
      name: account.name,
      type: account.type,
      currency: account.currency,
      source_system: account.source_system,
      external_account_id: account.external_account_id,
      mask: account.mask ?? null,
      reported_balance_minor: account.reported_balance_minor ?? null,
      reported_balance_at: account.reported_balance_minor != null ? new Date().toISOString() : null,
      // A credit card is a liability, not cash on hand.
      include_in_cash: account.include_in_cash ?? account.type !== 'credit_card',
    })
    .select('*')
    .single();

  if (error) throw new Error(`Could not create account ${account.name}: ${error.message}`);
  return data as FinancialAccount;
}

function sinceFor(integration: Integration, asOf: ISODate): ISODate {
  if (!integration.last_synced_at) return addDays(asOf, -INITIAL_LOOKBACK_DAYS);
  const last = integration.last_synced_at.slice(0, 10);
  return addDays(last, -INCREMENTAL_OVERLAP_DAYS);
}

async function markSynced(
  db: SupabaseClient,
  integrationId: string,
  patch: Record<string, unknown> = {},
): Promise<void> {
  await db
    .from('integrations')
    .update({ last_synced_at: new Date().toISOString(), last_error: null, status: 'connected', ...patch })
    .eq('id', integrationId);
}

async function markFailed(db: SupabaseClient, integrationId: string, message: string): Promise<void> {
  await db
    .from('integrations')
    .update({ status: 'error', last_error: message.slice(0, 500) })
    .eq('id', integrationId);
}

// ─── QuickBooks ─────────────────────────────────────────────────────────────

export async function syncQuickBooks(
  db: SupabaseClient,
  integration: Integration,
  asOf: ISODate = today(),
): Promise<SyncResult> {
  const result: SyncResult = {
    provider: 'quickbooks',
    inserted: 0,
    updated: 0,
    skipped: 0,
    accounts_touched: 0,
  };

  try {
    if (!qboConfigured()) throw new Error('QuickBooks env vars are not set.');
    if (!integration.external_id) throw new Error('QuickBooks integration has no realmId.');

    const accessToken = await getAccessToken(integration, async (tokens) => {
      await db.from('integrations').update(tokens).eq('id', integration.id);
    });

    const companyId = await ensureDefaultCompany(db);
    const qboAccounts = await fetchQboAccounts(accessToken, integration.external_id);

    const accountMap = new Map<string, string>();
    for (const acc of qboAccounts) {
      const row = await upsertAccount(db, companyId, {
        external_account_id: acc.Id,
        name: acc.Name,
        type: acc.AccountType === 'Credit Card' ? 'credit_card' : 'checking',
        currency: (acc.CurrencyRef?.value ?? 'USD').toUpperCase(),
        source_system: 'quickbooks',
        reported_balance_minor:
          typeof acc.CurrentBalance === 'number'
            ? toMinor(acc.CurrentBalance, (acc.CurrencyRef?.value ?? 'USD').toUpperCase())
            : null,
      });
      accountMap.set(acc.Id, row.id);
    }
    result.accounts_touched = accountMap.size;

    // A transaction whose QBO account we cannot resolve still has to land
    // somewhere, or the dollar disappears. It goes to an explicit holding
    // account that shows up in the reconcile queue.
    const fallbackId =
      accountMap.values().next().value ??
      (
        await upsertAccount(db, companyId, {
          external_account_id: 'qbo-unmapped',
          name: 'QuickBooks (unmapped account)',
          type: 'other',
          currency: 'USD',
          source_system: 'quickbooks',
        })
      ).id;

    const transactions = await fetchQboTransactions({
      accessToken,
      realmId: integration.external_id,
      since: sinceFor(integration, asOf),
      accountIdFor: (qboAccountId) =>
        (qboAccountId ? accountMap.get(qboAccountId) : undefined) ?? fallbackId,
    });

    const ingest = await ingestTransactions(db, transactions, { asOf });
    result.inserted = ingest.inserted;
    result.skipped = ingest.duplicatesSkipped;
    if (ingest.errors.length) result.error = ingest.errors.join('; ');

    await markSynced(db, integration.id);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    await markFailed(db, integration.id, result.error);
  }

  return result;
}

// ─── Plaid ──────────────────────────────────────────────────────────────────

export async function syncPlaid(
  db: SupabaseClient,
  integration: Integration,
  asOf: ISODate = today(),
): Promise<SyncResult> {
  const result: SyncResult = {
    provider: 'plaid',
    inserted: 0,
    updated: 0,
    skipped: 0,
    accounts_touched: 0,
  };

  try {
    if (!plaidConfigured()) throw new Error('Plaid env vars are not set.');
    if (!integration.access_token_enc) throw new Error('Plaid integration has no access token.');

    const accessToken = decryptSecret(integration.access_token_enc);
    const companyId = await ensureDefaultCompany(db);

    const plaidAccounts = await fetchPlaidAccounts(accessToken);
    const accountMap = new Map<string, string>();
    for (const acc of plaidAccounts) {
      const currency = (acc.balances.iso_currency_code ?? 'USD').toUpperCase();
      const mapped = mapAccountType(acc.type, acc.subtype);
      const owed = mapped.type === 'credit_card' || mapped.type === 'loan';
      const row = await upsertAccount(db, companyId, {
        external_account_id: acc.account_id,
        name: acc.official_name ?? acc.name,
        type: mapped.type,
        currency,
        source_system: 'plaid',
        mask: acc.mask,
        include_in_cash: mapped.countsAsCash,
        reported_balance_minor:
          acc.balances.current === null
            ? null
            : // Plaid reports what is OWED on a card or loan as a positive
              // number, so both are negated to read as the liability they are.
              toMinor(owed ? -acc.balances.current : acc.balances.current, currency),
      });
      accountMap.set(acc.account_id, row.id);
    }
    result.accounts_touched = accountMap.size;

    const sync = await plaidSyncTransactions(
      accessToken,
      integration.last_cursor,
      (plaidAccountId) => accountMap.get(plaidAccountId) ?? null,
    );

    const ingest = await ingestTransactions(db, sync.transactions, { asOf });
    result.inserted = ingest.inserted;
    result.skipped = ingest.duplicatesSkipped;
    if (ingest.errors.length) result.error = ingest.errors.join('; ');

    // Plaid removes a transaction when the bank reverses it. Deleting keeps
    // cash honest; the audit log keeps the fact that it existed.
    if (sync.removedIds.length) {
      await db
        .from('transactions')
        .delete()
        .eq('source_system', 'plaid')
        .in('external_txn_id', sync.removedIds);
    }

    await markSynced(db, integration.id, { last_cursor: sync.cursor });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    await markFailed(db, integration.id, result.error);
  }

  return result;
}

// ─── Stripe ─────────────────────────────────────────────────────────────────

export async function syncStripe(
  db: SupabaseClient,
  integration: Integration,
  asOf: ISODate = today(),
): Promise<SyncResult> {
  const result: SyncResult = {
    provider: 'stripe',
    inserted: 0,
    updated: 0,
    skipped: 0,
    accounts_touched: 0,
  };

  try {
    if (!stripeConfigured()) throw new Error('STRIPE_SECRET_KEY is not set.');

    const companyId = await ensureDefaultCompany(db);
    const balances = await fetchStripeBalance();
    const currency = Object.keys(balances)[0] ?? 'USD';

    const account = await upsertAccount(db, companyId, {
      external_account_id: 'stripe-balance',
      name: 'Stripe balance',
      type: 'payment_processor',
      currency,
      source_system: 'stripe',
      reported_balance_minor: balances[currency] ?? null,
    });
    result.accounts_touched = 1;

    const transactions = await fetchStripeTransactions(account.id, sinceFor(integration, asOf));
    const ingest = await ingestTransactions(db, transactions, { asOf });
    result.inserted = ingest.inserted;
    result.skipped = ingest.duplicatesSkipped;
    if (ingest.errors.length) result.error = ingest.errors.join('; ');

    await markSynced(db, integration.id);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    await markFailed(db, integration.id, result.error);
  }

  return result;
}

// ─── All providers ──────────────────────────────────────────────────────────

export async function syncAllIntegrations(
  db: SupabaseClient,
  asOf: ISODate = today(),
): Promise<SyncResult[]> {
  const { data: integrations, error } = await db
    .from('integrations')
    .select('*')
    .neq('status', 'disconnected');

  if (error) return [{ provider: 'none', inserted: 0, updated: 0, skipped: 0, accounts_touched: 0, error: error.message }];

  const results: SyncResult[] = [];
  for (const integration of (integrations ?? []) as Integration[]) {
    switch (integration.provider) {
      case 'quickbooks':
        results.push(await syncQuickBooks(db, integration, asOf));
        break;
      case 'plaid':
        results.push(await syncPlaid(db, integration, asOf));
        break;
      case 'stripe':
        results.push(await syncStripe(db, integration, asOf));
        break;
    }
  }
  return results;
}

/** Store a freshly issued token pair, encrypted. */
export async function saveIntegrationTokens(
  db: SupabaseClient,
  options: {
    provider: 'quickbooks' | 'plaid' | 'stripe';
    externalId: string;
    label?: string;
    accessToken: string;
    refreshToken?: string | null;
    expiresInSeconds?: number | null;
    metadata?: Record<string, unknown>;
  },
): Promise<Integration> {
  const { data, error } = await db
    .from('integrations')
    .upsert(
      {
        provider: options.provider,
        external_id: options.externalId,
        label: options.label ?? null,
        status: 'connected',
        access_token_enc: encryptSecret(options.accessToken),
        refresh_token_enc: options.refreshToken ? encryptSecret(options.refreshToken) : null,
        token_expires_at: options.expiresInSeconds
          ? new Date(Date.now() + options.expiresInSeconds * 1000).toISOString()
          : null,
        metadata: options.metadata ?? {},
        last_error: null,
      },
      { onConflict: 'provider,external_id' },
    )
    .select('*')
    .single();

  if (error) throw new Error(`Could not save integration: ${error.message}`);
  return data as Integration;
}
