/**
 * Sync orchestration - the layer the cron route and the "Sync now" button both
 * call. One entry point per provider, all funnelling into `ingestTransactions`.
 *
 * Design rule: a failure in one provider must not stop the others. If Plaid is
 * down, the QuickBooks pull still runs and the CEO still gets alerts for the
 * dollars we can see. Each provider result carries its own error string.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { FinancialAccount, Integration, NormalizedTransaction, SyncResult } from '@/lib/types';
import { addDays, today, type ISODate } from '@/lib/dates';
import { ingestTransactions } from '@/lib/ingest';
import { decryptSecret, encryptSecret } from '@/lib/crypto';
import { parseAmountToMinor } from '@/lib/money';
import {
  CDC_ENTITIES,
  createQboSession,
  fetchQboAccounts,
  fetchQboChanges,
  fetchQboObligations,
  fetchQboTransactions,
  nextUnavailable,
  normaliseCashRow,
  normaliseObligationRow,
  planQboSync,
  qboConfigured,
  type QboChangeSet,
  type QboObligation,
  type UnavailableMap,
} from '@/lib/connectors/quickbooks';
import { syncQboObligations } from '@/lib/obligations-sync';
import { ProviderAuthError } from '@/lib/connectors/retry';
import { notifyReconnectNeeded } from '@/lib/alerts/reconnect';
import { recordIntegrationError } from '@/lib/integration-errors';
import {
  fetchAccessToken,
  fetchAllPayments,
  normalizePayment,
  splitByStatus,
  veemConfigProblems,
} from '@/lib/connectors/veem';
import {
  fetchAccounts as fetchPlaidAccounts,
  mapAccountType,
  plaidConfigured,
  syncTransactions as plaidSyncTransactions,
} from '@/lib/connectors/plaid';
import {
  amountToMinor,
  fetchAccounts as fetchFinverseAccounts,
  fetchTransactions as fetchFinverseTransactions,
  finverseConfigured,
  mapFinverseAccountType,
  normalizeTransactions as normalizeFinverseTransactions,
} from '@/lib/connectors/finverse';
import {
  fetchStatement,
  normalizeStatement,
  vietinbankConfigProblems,
} from '@/lib/connectors/vietinbank';
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

/**
 * Record a failed sync, distinguishing the kind that fixes itself from the kind
 * that never will.
 *
 * A `ProviderAuthError` carrying `reconnect` means the grant is gone: the
 * customer disconnected from inside the provider, or the refresh token expired.
 * Writing `status: 'error'` for that is what made a dead QuickBooks connection
 * indistinguishable from a provider having a bad afternoon — and it retried,
 * silently, every ten minutes, for as long as nobody looked.
 *
 * `advice` rather than `message` is stored for those, because `last_error` is
 * rendered to a person on the Integrations page. "invalid_grant" is the
 * accurate string and it tells them nothing they can act on.
 */
async function markFailed(
  db: SupabaseClient,
  integrationId: string,
  message: string,
  cause?: unknown,
  provider = 'unknown',
): Promise<void> {
  const authError = cause instanceof ProviderAuthError ? cause : null;
  const needsReconnect = authError?.needsReconnect ?? false;

  // Kept before anything else can go wrong. `last_error` below is overwritten
  // by the next failure and cleared by the next success; this row is not.
  await recordIntegrationError(db, {
    integrationId,
    provider: authError?.provider ?? provider,
    operation: 'sync',
    error: cause ?? message,
  });

  // Read BEFORE the write. The alert must fire on the transition into
  // "needs reconnecting", and once the status has been set there is no way left
  // to tell a first detection from the 144th of the day — the condition repeats
  // on every ten-minute tick until a person acts.
  const { data: before } = await db
    .from('integrations')
    .select('status')
    .eq('id', integrationId)
    .maybeSingle();
  const wasAlreadyFlagged =
    (before as { status?: string } | null)?.status === 'reauth_required';

  await db
    .from('integrations')
    .update({
      status: needsReconnect ? 'reauth_required' : 'error',
      // The tid goes on the card too, so whoever is looking at the page can
      // quote it to Intuit without opening the log.
      last_error: (
        (authError?.advice ?? message) + (authError?.tid ? ` (intuit_tid ${authError.tid})` : '')
      ).slice(0, 500),
    })
    .eq('id', integrationId);

  // Telling somebody to reconnect only on a page they may not open for a week
  // is not telling them. The sync runs headless; without this, the first sign
  // of a dead connection is stale figures nobody thought to question.
  if (needsReconnect && !wasAlreadyFlagged) {
    await notifyReconnectNeeded(db, {
      provider: authError!.provider,
      advice: authError!.advice,
    });
  }
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

    // Every QuickBooks call in this function goes through the session, so a
    // 401 anywhere buys one forced refresh and one retry rather than becoming
    // a "please reconnect" for a connection that only needed a new token.
    const session = createQboSession(integration, async (tokens) => {
      await db.from('integrations').update(tokens).eq('id', integration.id);
    });

    const companyId = await ensureDefaultCompany(db);
    const qboAccounts = await session.run((accessToken) =>
      fetchQboAccounts(accessToken, integration.external_id!),
    );

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

    const realmId = integration.external_id!;
    const accountIdFor = (qboAccountId: string | null) =>
      (qboAccountId ? accountMap.get(qboAccountId) : undefined) ?? fallbackId;

    /*
     * CDC for incremental syncs, the full query path when in any doubt.
     *
     * The query path cannot see deletions and only reaches back seven days, so
     * a purchase deleted in QuickBooks stayed in AHN's ledger and an old
     * invoice corrected today was never picked up. CDC sees both, in one call
     * instead of eight. `planQboSync` decides; its reasons are in the result.
     */
    const now = new Date();
    const known = ((integration.metadata ?? {}) as { qbo_unavailable?: UnavailableMap })
      .qbo_unavailable ?? {};
    const plan = planQboSync({ lastSyncedAt: integration.last_synced_at, unavailable: known, now });
    const refused: string[] = [];

    let changes: QboChangeSet | null = null;
    let reason = plan.reason;
    if (plan.path === 'cdc' && plan.changedSince) {
      try {
        const set = await session.run((accessToken) =>
          fetchQboChanges(
            accessToken,
            realmId,
            CDC_ENTITIES.map((e) => e.entity).filter((e) => !plan.skip.includes(e)),
            plan.changedSince!,
          ),
        );
        // A change set that may be cut off is not trusted with the ledger.
        if (set.truncated) reason = `CDC returned ${set.size} objects and may be cut off — full query instead`;
        else changes = set;
      } catch (err) {
        // The subscription lost a feature since the last sync. The query path
        // asks entity by entity and finds out which.
        if (!(err instanceof ProviderAuthError && err.kind === 'unavailable')) throw err;
        reason = 'the subscription no longer includes something CDC asked for — checking each entity';
      }
    }
    result.mode = { path: changes ? 'cdc' : 'query', reason };

    let transactions: NormalizedTransaction[];
    const deletedTxnIds: string[] = [];
    if (changes) {
      transactions = [];
      for (const { entity, direction, kind } of CDC_ENTITIES) {
        if (kind !== 'cash') continue;
        for (const row of changes.changed[entity] ?? []) {
          const txn = normaliseCashRow(entity, direction, row, accountIdFor, asOf);
          if (txn) transactions.push(txn);
        }
        for (const id of changes.deleted[entity] ?? []) deletedTxnIds.push(`${entity}:${id}`);
      }
    } else {
      transactions = await session.run((accessToken) =>
        fetchQboTransactions({
          accessToken,
          realmId,
          since: sinceFor(integration, asOf),
          accountIdFor,
          skip: plan.skip,
          unavailable: refused,
        }),
      );
    }

    const ingest = await ingestTransactions(db, transactions, { asOf });
    result.inserted = ingest.inserted;
    result.skipped = ingest.duplicatesSkipped;
    if (ingest.errors.length) result.error = ingest.errors.join('; ');

    // Deleted in QuickBooks, so deleted here — the same rule Plaid follows when
    // a bank reverses a transaction. Leaving it would count cash that never
    // moved. The audit log keeps the fact that it existed.
    if (deletedTxnIds.length) {
      const { error: deleteError } = await db
        .from('transactions')
        .delete()
        .eq('source_system', 'quickbooks')
        .in('external_txn_id', deletedTxnIds);
      if (deleteError) {
        const note = `deletions: ${deleteError.message}`;
        result.error = result.error ? `${result.error}; ${note}` : note;
        await recordIntegrationError(db, {
          integrationId: integration.id,
          provider: 'quickbooks',
          operation: 'sync',
          error: note,
        });
      } else {
        result.deleted = deletedTxnIds.length;
      }
    }

    /*
     * Invoices and bills, in the same pass but not into the same table.
     *
     * A failure here must not undo the transaction sync that already
     * succeeded. The cash figures are the ones the company runs on, and losing
     * them because one invoice had a malformed due date would be the wrong
     * trade. The error is reported; the rows already written stand.
     */
    try {
      let owed: QboObligation[];
      const voided: string[] = [];
      if (changes) {
        owed = [];
        for (const { entity, direction, kind } of CDC_ENTITIES) {
          if (kind !== 'obligation') continue;
          for (const row of changes.changed[entity] ?? []) {
            const obligation = normaliseObligationRow(entity, direction, row);
            if (obligation) owed.push(obligation);
          }
          for (const id of changes.deleted[entity] ?? []) voided.push(`${entity}:${id}`);
        }
      } else {
        owed = await session.run((accessToken) =>
          fetchQboObligations({
            accessToken,
            realmId,
            since: sinceFor(integration, asOf),
            skip: plan.skip,
            unavailable: refused,
          }),
        );
      }
      const written = await syncQboObligations(db, owed);

      // An invoice or bill deleted in QuickBooks is voided, not deleted: the
      // obligations table's own rule is "cancelled or written off; kept, never
      // deleted" (migration 0019).
      if (voided.length) {
        const { error: voidError } = await db
          .from('obligations')
          .update({ status: 'void' })
          .eq('source_system', 'quickbooks')
          .in('external_id', voided);
        if (voidError) throw new Error(`could not void deleted obligations: ${voidError.message}`);
      }
      result.obligations = {
        inserted: written.inserted,
        updated: written.updated,
        settled: written.settled,
        skipped: written.skipped,
      };
      if (written.errors.length) {
        const note = `obligations: ${written.errors.slice(0, 3).join('; ')}`;
        result.error = result.error ? `${result.error}; ${note}` : note;
      }
    } catch (err) {
      const note = `obligations: ${err instanceof Error ? err.message : String(err)}`;
      result.error = result.error ? `${result.error}; ${note}` : note;
      await recordIntegrationError(db, {
        integrationId: integration.id,
        provider: 'quickbooks',
        operation: 'sync',
        error: err,
      });
    }

    // What this subscription does not include, remembered so the next ten-minute
    // tick does not ask again — and forgotten the moment it is answered.
    const unavailable = nextUnavailable(known, plan.skip, refused, now);
    if (Object.keys(unavailable).length) result.unavailable = Object.keys(unavailable);

    await markSynced(db, integration.id, {
      metadata: { ...(integration.metadata ?? {}), qbo_unavailable: unavailable },
    });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    await markFailed(db, integration.id, result.error, err, integration.provider);
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
    await markFailed(db, integration.id, result.error, err, integration.provider);
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
    await markFailed(db, integration.id, result.error, err, integration.provider);
  }

  return result;
}

// ─── All providers ──────────────────────────────────────────────────────────

/**
 * Finverse - the Vietnamese bank route (spec section 2).
 *
 * The access token stored on the integration is the LOGIN IDENTITY token: the
 * one the Link flow produced when a person signed in at their bank. Finverse
 * never hands over bank credentials, which is the whole reason to go through an
 * aggregator rather than holding them ourselves.
 */
export async function syncFinverse(
  db: SupabaseClient,
  integration: Integration,
  asOf: ISODate = today(),
): Promise<SyncResult> {
  const result: SyncResult = {
    provider: 'finverse',
    inserted: 0,
    updated: 0,
    skipped: 0,
    accounts_touched: 0,
  };

  try {
    if (!finverseConfigured()) throw new Error('Finverse env vars are not set.');
    if (!integration.access_token_enc) {
      throw new Error('Finverse integration has no login-identity token. Re-run the Link flow.');
    }

    const loginToken = decryptSecret(integration.access_token_enc);
    const companyId = await ensureDefaultCompany(db);

    const accounts = await fetchFinverseAccounts(loginToken);
    const accountMap = new Map<string, string>();
    const currencyMap = new Map<string, string>();

    for (const acc of accounts) {
      // A closed account still has history worth keeping, but nothing new will
      // arrive; an excluded one the person chose not to share.
      if (acc.is_excluded) continue;

      const currency = (acc.account_currency ?? acc.balance?.currency ?? 'VND').toUpperCase();
      const mapped = mapFinverseAccountType(acc.account_type?.subtype);
      const owed = mapped.type === 'credit_card' || mapped.type === 'loan';
      const balanceMinor = amountToMinor(acc.balance, currency);

      const row = await upsertAccount(db, companyId, {
        external_account_id: acc.account_id,
        name: acc.account_nickname ?? acc.account_name,
        type: mapped.type,
        currency,
        source_system: 'finverse',
        mask: acc.account_number_masked ?? null,
        include_in_cash: mapped.countsAsCash && !acc.is_closed,
        reported_balance_minor:
          balanceMinor === null
            ? null
            : // What is OWED on a card or a loan comes back positive, exactly as
              // it does from Plaid. Negated so it reads as the liability it is
              // rather than as money the company could spend.
              owed
              ? -Math.abs(balanceMinor)
              : balanceMinor,
      });

      accountMap.set(acc.account_id, row.id);
      currencyMap.set(acc.account_id, currency);
    }
    result.accounts_touched = accountMap.size;

    const raw = await fetchFinverseTransactions(loginToken);
    const normalized = normalizeFinverseTransactions(raw, { accountMap, currencyMap });

    const ingest = await ingestTransactions(db, normalized.rows, { asOf });
    result.inserted = ingest.inserted;
    result.skipped = ingest.duplicatesSkipped + normalized.skippedPending;

    // What was NOT taken, and why. A sync that silently drops rows is a sync
    // that quietly disagrees with the bank.
    const notes: string[] = [];
    if (normalized.skippedPending) notes.push(`${normalized.skippedPending} pending`);
    if (normalized.skippedUnknownAccount) {
      notes.push(`${normalized.skippedUnknownAccount} from unmapped accounts`);
    }
    if (normalized.skippedNoAmount) notes.push(`${normalized.skippedNoAmount} with no readable amount`);
    if (ingest.errors.length) notes.push(...ingest.errors);
    if (notes.length) result.error = `skipped: ${notes.join(', ')}`;

    await db
      .from('integrations')
      .update({ status: 'connected', last_synced_at: new Date().toISOString(), last_error: null })
      .eq('id', integration.id);
  } catch (err) {
    result.error = err instanceof Error ? err.message : 'Finverse sync failed.';
    await db
      .from('integrations')
      .update({ status: 'error', last_error: result.error })
      .eq('id', integration.id);
    await recordIntegrationError(db, {
      integrationId: integration.id,
      provider: integration.provider,
      operation: 'sync',
      error: err,
    });
  }

  return result;
}

/**
 * VietinBank iConnect - the corporate Vietnamese route (spec section 2).
 *
 * One call returns a whole statement for one account and one date range, so
 * there is no cursor to keep. The window is bounded instead: re-reading the
 * last few weeks each run picks up anything the bank posted late, and
 * `ingestTransactions` drops what it has already seen on
 * (source_system, external_txn_id).
 */
export async function syncVietinBank(
  db: SupabaseClient,
  integration: Integration,
  asOf: ISODate = today(),
): Promise<SyncResult> {
  const result: SyncResult = {
    provider: 'vietinbank',
    inserted: 0,
    updated: 0,
    skipped: 0,
    accounts_touched: 0,
  };

  try {
    const problems = vietinbankConfigProblems();
    if (problems.length) throw new Error(problems.join(' '));

    const accountNumber = integration.external_id ?? process.env.VIETINBANK_ACCOUNT_NUMBER!;
    const from = addDays(asOf, -VIETINBANK_WINDOW_DAYS);

    const statement = await fetchStatement({ account: accountNumber, from, to: asOf });
    const currency = (statement.curency ?? 'VND').toUpperCase();
    const companyId = await ensureDefaultCompany(db);

    // The statement carries the closing balance, which is what the reconcile
    // page compares our transactions against.
    const reported = statement.closingBal ?? statement.accountBal ?? null;
    const reportedMinor =
      reported === null ? null : (parseAmountToMinor(reported, currency) ?? null);

    const account = await upsertAccount(db, companyId, {
      external_account_id: accountNumber,
      name: statement.companyName
        ? `${statement.companyName} — ${accountNumber}`
        : `VietinBank ${accountNumber}`,
      type: 'checking',
      currency,
      source_system: 'vietinbank',
      mask: accountNumber.slice(-4),
      include_in_cash: true,
      reported_balance_minor: reportedMinor,
    });
    result.accounts_touched = 1;

    const normalized = normalizeStatement(statement, {
      accountId: account.id,
      currency,
    });

    const ingest = await ingestTransactions(db, normalized.rows, { asOf });
    result.inserted = ingest.inserted;
    result.skipped = ingest.duplicatesSkipped;

    // What was NOT taken, and why. A sync that silently drops rows is a sync
    // that quietly disagrees with the bank.
    const notes: string[] = [];
    if (normalized.skippedNoDate) notes.push(`${normalized.skippedNoDate} with an unreadable date`);
    if (normalized.skippedNoAmount) {
      notes.push(`${normalized.skippedNoAmount} with no readable amount`);
    }
    if (ingest.errors.length) notes.push(...ingest.errors);
    if (notes.length) result.error = `skipped: ${notes.join(', ')}`;

    await db
      .from('integrations')
      .update({
        status: 'connected',
        last_synced_at: new Date().toISOString(),
        last_error: null,
        external_id: accountNumber,
      })
      .eq('id', integration.id);
  } catch (err) {
    result.error = err instanceof Error ? err.message : 'VietinBank sync failed.';
    await db
      .from('integrations')
      .update({ status: 'error', last_error: result.error })
      .eq('id', integration.id);
    await recordIntegrationError(db, {
      integrationId: integration.id,
      provider: integration.provider,
      operation: 'sync',
      error: err,
    });
  }

  return result;
}

/**
 * How far back each run re-reads.
 *
 * Long enough that a bank posting a transaction several days late is still
 * caught, short enough that a daily sync is not pulling a year of statement
 * every time. Re-read rows cost nothing: they are dropped on the unique index.
 */
const VIETINBANK_WINDOW_DAYS = 35;

// ─── VEEM ───────────────────────────────────────────────────────────────────

/**
 * How far back each run re-reads. Same reasoning as VietinBank: a payment that
 * completes late is still caught, and re-read rows cost nothing because
 * `ingestTransactions` drops them on (source_system, external_txn_id).
 */
const VEEM_WINDOW_DAYS = 35;

/**
 * VEEM - Spec section 2 ("especially for Philippines payroll") and section 18.
 *
 * THE SPLIT IS THE POINT. Veem's report returns payments at every stage of
 * their life, and only `Complete` has actually moved money. A payment Veem has
 * accepted but not yet delivered is not cash — counting it as cash overstates
 * what left the bank. It is also not nothing: it is exactly the "known
 * commitment before money leaves the bank" that section 18 asks for. So
 * completed payments become transactions and in-flight ones become
 * obligations, the same division decision 85 made for QuickBooks.
 *
 * A payment that later completes is written to the ledger by this same job,
 * and its obligation is settled — so it is never counted twice.
 */
export async function syncVeem(
  db: SupabaseClient,
  integration: Integration,
  asOf: ISODate = today(),
): Promise<SyncResult> {
  const result: SyncResult = {
    provider: 'veem',
    inserted: 0,
    updated: 0,
    skipped: 0,
    accounts_touched: 0,
  };

  try {
    const problems = veemConfigProblems();
    if (problems.length > 0) throw new Error(problems.join(' '));

    const accessToken = await fetchAccessToken();
    const from = addDays(asOf, -VEEM_WINDOW_DAYS);

    const payments = await fetchAllPayments({ accessToken, from, to: asOf });
    const normalized = payments
      .map((p) => normalizePayment(p, { ownAccountId: process.env.VEEM_ACCOUNT_ID ?? null }))
      .filter((p): p is NonNullable<typeof p> => p !== null);

    const { settled, inFlight, discarded } = splitByStatus(normalized);

    const companyId = await ensureDefaultCompany(db);
    const account = await upsertAccount(db, companyId, {
      external_account_id: 'veem-main',
      name: 'VEEM',
      type: 'other',
      currency: 'USD',
      source_system: 'veem',
    });
    result.accounts_touched = 1;

    // --- Money that has moved -------------------------------------------------
    const rows = settled
      .filter((p) => p.date !== null)
      .map((p) => ({
        account_id: account.id,
        external_txn_id: p.externalId,
        source_system: 'veem' as const,
        txn_date: p.date!,
        amount_minor: p.amountMinor,
        currency: p.currency,
        direction: p.direction,
        description: p.description ?? `VEEM payment to ${p.counterpartyName}`,
        counterparty_name: p.counterpartyName,
      }));

    const ingest = await ingestTransactions(db, rows, { asOf });
    result.inserted = ingest.inserted;
    result.skipped = ingest.duplicatesSkipped + discarded.length;
    if (ingest.errors.length) result.error = ingest.errors.join('; ');

    // --- Money on its way -----------------------------------------------------
    let created = 0;
    let settledNow = 0;
    for (const p of inFlight) {
      if (!p.date) continue;
      const { error: upsertError } = await db.from('obligations').upsert(
        {
          direction: p.direction,
          counterparty_name: p.counterpartyName,
          description: p.description ?? `VEEM payment, ${p.status}`,
          amount_minor: p.amountMinor,
          currency: p.currency,
          // Veem gives a creation time, not a promised delivery date. Using the
          // creation date as the due date is honest about what is known: the
          // money is committed from that moment, and aging from it never claims
          // a deadline nobody set.
          issued_on: p.date,
          due_on: p.date,
          status: 'open',
          source_system: 'veem',
          external_id: p.externalId,
        },
        { onConflict: 'source_system,external_id' },
      );
      if (upsertError) continue;
      created += 1;
    }

    /*
     * A payment that has completed must stop being a commitment.
     *
     * Without this it would sit open forever AND appear in the ledger — the
     * same dollar counted twice, once as cash gone and once as cash about to
     * go. `settled_on` is the day Veem completed it.
     */
    for (const p of settled) {
      if (!p.date) continue;
      const { error: closeError } = await db
        .from('obligations')
        .update({ status: 'settled', settled_on: p.date })
        .eq('source_system', 'veem')
        .eq('external_id', p.externalId)
        .neq('status', 'settled');
      if (!closeError) settledNow += 1;
    }

    result.obligations = {
      inserted: created,
      updated: 0,
      settled: settledNow,
      skipped: discarded.length,
    };

    await db
      .from('integrations')
      .update({ status: 'connected', last_synced_at: new Date().toISOString(), last_error: null })
      .eq('id', integration.id);
  } catch (err) {
    result.error = err instanceof Error ? err.message : 'VEEM sync failed.';
    await db
      .from('integrations')
      .update({ status: 'error', last_error: result.error })
      .eq('id', integration.id);
    await recordIntegrationError(db, {
      integrationId: integration.id,
      provider: integration.provider,
      operation: 'sync',
      error: err,
    });
  }

  return result;
}

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
      case 'finverse':
        results.push(await syncFinverse(db, integration, asOf));
        break;
      case 'vietinbank':
        results.push(await syncVietinBank(db, integration, asOf));
        break;
      case 'veem':
        results.push(await syncVeem(db, integration, asOf));
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
