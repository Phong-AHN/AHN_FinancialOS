/**
 * QuickBooks Online connector - MVP Plan Day 2, Spec section 2.
 *
 * QuickBooks is the accounting source of truth (spec section 29); this app is
 * the operational layer above it. So QBO rows win ties in the deduplicator and
 * their categories are trusted over our rule-based guess.
 *
 * WHICH ENTITIES ARE SYNCED, AND WHY
 * Only cash-affecting entities land in `transactions`: Purchase, Deposit,
 * Payment, BillPayment. Invoices and Bills are ACCRUALS - an invoice and the
 * payment that settles it are the same dollar, and booking both would break the
 * non-negotiable "no transaction is double-counted" criterion (spec section 28).
 * Invoices and bills belong to the AR/AP module (spec sections 17-18), which is
 * Phase 2 and gets its own tables.
 */

import { decryptSecret, encryptSecret } from '@/lib/crypto';
import { parseAmount, toMinor } from '@/lib/money';
import type { Integration, NormalizedTransaction, TxnDirection } from '@/lib/types';
import type { ISODate } from '@/lib/dates';

const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const SCOPE = 'com.intuit.quickbooks.accounting';

/**
 * Intuit has exactly two environments: `sandbox` and `production`.
 *
 * Anything else is a misconfiguration, and the common one is `development` -
 * copied across from `PLAID_ENV`, which does use that word. Treating an
 * unrecognised value as production (the obvious-looking default) means sandbox
 * credentials get pointed at the live API and fail with an opaque 401 during
 * OAuth, long after the actual mistake was made.
 */
export type QboEnvironment = 'sandbox' | 'production';

export interface QboEnvCheck {
  environment: QboEnvironment;
  /** False when QBO_ENVIRONMENT held something Intuit does not recognise. */
  valid: boolean;
  rawValue: string | null;
}

export function qboEnvironment(): QboEnvCheck {
  const raw = process.env.QBO_ENVIRONMENT?.trim().toLowerCase() ?? null;
  if (raw === 'sandbox' || raw === 'production') {
    return { environment: raw, valid: true, rawValue: raw };
  }
  // Unset is fine and means production, matching .env.example.
  if (!raw) return { environment: 'production', valid: true, rawValue: null };
  return { environment: 'production', valid: false, rawValue: raw };
}

export function qboApiBase(): string {
  return qboEnvironment().environment === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
}

export function qboConfigured(): boolean {
  return Boolean(process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET);
}

/**
 * Everything wrong with the QuickBooks configuration, in one call, so the
 * Integrations page can say exactly what is missing instead of "credentials
 * missing" for six different causes.
 */
export function qboConfigProblems(): string[] {
  const problems: string[] = [];
  if (!process.env.QBO_CLIENT_ID) problems.push('QBO_CLIENT_ID is not set.');
  if (!process.env.QBO_CLIENT_SECRET) problems.push('QBO_CLIENT_SECRET is not set.');

  const env = qboEnvironment();
  if (!env.valid) {
    problems.push(
      `QBO_ENVIRONMENT is "${env.rawValue}", which Intuit does not recognise. Use "sandbox" or "production" (note: "development" is a Plaid value, not a QuickBooks one).`,
    );
  }

  const redirect = process.env.QBO_REDIRECT_URI;
  if (redirect && !/\/api\/integrations\/quickbooks\/callback$/.test(redirect)) {
    problems.push(
      `QBO_REDIRECT_URI must end in /api/integrations/quickbooks/callback — it is currently "${redirect}".`,
    );
  }
  return problems;
}

function redirectUri(): string {
  return (
    process.env.QBO_REDIRECT_URI ??
    `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/integrations/quickbooks/callback`
  );
}

/** Step 1 of OAuth2: where to send the user. `state` is the CSRF guard. */
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.QBO_CLIENT_ID!,
    response_type: 'code',
    scope: SCOPE,
    redirect_uri: redirectUri(),
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

function basicAuthHeader(): string {
  const pair = `${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(pair).toString('base64')}`;
}

async function requestToken(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: basicAuthHeader(),
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`QuickBooks token request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  return requestToken(
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() }),
  );
}

export async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  return requestToken(
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  );
}

/**
 * Returns a usable access token, refreshing it first when it is close to
 * expiry. The 60-second cushion stops a token from dying mid-sync.
 */
export async function getAccessToken(
  integration: Integration,
  onRefresh: (tokens: {
    access_token_enc: string;
    refresh_token_enc: string;
    token_expires_at: string;
  }) => Promise<void>,
): Promise<string> {
  if (!integration.access_token_enc || !integration.refresh_token_enc) {
    throw new Error('QuickBooks integration has no stored tokens. Reconnect it.');
  }

  const expiresAt = integration.token_expires_at
    ? new Date(integration.token_expires_at).getTime()
    : 0;

  if (expiresAt > Date.now() + 60_000) {
    return decryptSecret(integration.access_token_enc);
  }

  const tokens = await refreshTokens(decryptSecret(integration.refresh_token_enc));
  await onRefresh({
    access_token_enc: encryptSecret(tokens.access_token),
    refresh_token_enc: encryptSecret(tokens.refresh_token),
    token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  });
  return tokens.access_token;
}

// ─── Query API ──────────────────────────────────────────────────────────────

async function query<T>(
  accessToken: string,
  realmId: string,
  statement: string,
  entity: string,
): Promise<T[]> {
  const url = `${qboApiBase()}/v3/company/${realmId}/query?query=${encodeURIComponent(statement)}&minorversion=70`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`QuickBooks query failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as { QueryResponse?: Record<string, T[]> };
  return json.QueryResponse?.[entity] ?? [];
}

/** Paginates a QBO query; the API caps a page at 1000 rows. */
async function queryAll<T>(
  accessToken: string,
  realmId: string,
  entity: string,
  where: string,
): Promise<T[]> {
  const pageSize = 500;
  const all: T[] = [];
  for (let start = 1; ; start += pageSize) {
    const statement = `select * from ${entity} where ${where} startposition ${start} maxresults ${pageSize}`;
    const page = await query<T>(accessToken, realmId, statement, entity);
    all.push(...page);
    if (page.length < pageSize) break;
    if (all.length > 20_000) break; // hard stop against a runaway pull
  }
  return all;
}

interface QboRef {
  value?: string;
  name?: string;
}
interface QboRow {
  Id: string;
  TxnDate?: string;
  TotalAmt?: number | string;
  CurrencyRef?: QboRef;
  PrivateNote?: string;
  EntityRef?: QboRef;
  VendorRef?: QboRef;
  CustomerRef?: QboRef;
  PaymentType?: string;
  AccountRef?: QboRef;
  DepositToAccountRef?: QboRef;
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
  Line?: Array<{
    Amount?: number;
    Description?: string;
    AccountBasedExpenseLineDetail?: { AccountRef?: QboRef };
    DepositLineDetail?: { AccountRef?: QboRef };
  }>;
}

/** Cash-affecting entity -> which way the money moved. */
const CASH_ENTITIES: Array<{ entity: string; direction: TxnDirection }> = [
  { entity: 'Purchase', direction: 'outflow' },
  { entity: 'BillPayment', direction: 'outflow' },
  { entity: 'Deposit', direction: 'inflow' },
  { entity: 'Payment', direction: 'inflow' },
];

export interface QboSyncOptions {
  accessToken: string;
  realmId: string;
  /** Map a QBO account id to one of our financial_accounts rows. */
  accountIdFor: (qboAccountId: string | null, qboAccountName: string | null) => string;
  since: ISODate;
}

/** Pull cash-affecting transactions and normalise them for `ingestTransactions`. */
export async function fetchQboTransactions(
  options: QboSyncOptions,
): Promise<NormalizedTransaction[]> {
  const out: NormalizedTransaction[] = [];

  for (const { entity, direction } of CASH_ENTITIES) {
    const rows = await queryAll<QboRow>(
      options.accessToken,
      options.realmId,
      entity,
      `TxnDate >= '${options.since}'`,
    );

    for (const row of rows) {
      const amount = parseAmount(row.TotalAmt ?? null);
      if (amount === null) continue;

      const currency = (row.CurrencyRef?.value ?? 'USD').toUpperCase();
      const qboAccount =
        row.AccountRef ?? row.DepositToAccountRef ?? row.Line?.[0]?.DepositLineDetail?.AccountRef ?? null;

      const counterparty =
        row.EntityRef?.name ?? row.VendorRef?.name ?? row.CustomerRef?.name ?? null;

      const lineCategory =
        row.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef?.name ?? null;

      out.push({
        account_id: options.accountIdFor(qboAccount?.value ?? null, qboAccount?.name ?? null),
        txn_date: row.TxnDate ?? options.since,
        posted_at: row.MetaData?.CreateTime ?? null,
        // QBO reports magnitudes; the entity type carries the direction.
        amount_minor: toMinor(Math.abs(amount), currency),
        currency,
        direction,
        description:
          row.PrivateNote ?? row.Line?.[0]?.Description ?? `${entity} ${row.Id}`,
        counterparty_name: counterparty,
        // The ledger account name is a better category than any guess we make.
        subcategory: lineCategory,
        source_system: 'quickbooks',
        external_txn_id: `${entity}:${row.Id}`,
        raw: row as unknown as Record<string, unknown>,
      });
    }
  }

  return out;
}

export interface QboAccount {
  Id: string;
  Name: string;
  AccountType: string;
  AccountSubType?: string;
  CurrentBalance?: number;
  CurrencyRef?: QboRef;
  Active?: boolean;
}

/** Bank/credit-card accounts, used to create matching `financial_accounts`. */
export async function fetchQboAccounts(
  accessToken: string,
  realmId: string,
): Promise<QboAccount[]> {
  const rows = await queryAll<QboAccount>(
    accessToken,
    realmId,
    'Account',
    "AccountType in ('Bank','Credit Card') and Active = true",
  );
  return rows;
}

// ─── Receivables and payables (spec §17, §18) ───────────────────────────────

/**
 * Invoices and bills, which are ACCRUALS rather than cash.
 *
 * The transaction sync deliberately skips these: an invoice and the payment
 * that settles it are two records of one event, and counting both would double
 * every dollar AHN earns. They belong in `obligations`, which exists precisely
 * to hold money that is going to move rather than money that has.
 */
interface QboObligationRow extends QboRow {
  DocNumber?: string;
  DueDate?: string;
  Balance?: number | string;
  CustomerMemo?: { value?: string };
}

export interface QboObligation {
  externalId: string;
  direction: TxnDirection;
  counterpartyName: string | null;
  reference: string | null;
  description: string | null;
  /** What is still owed, in minor units. Zero once it is paid. */
  amountMinor: number;
  /** What was originally invoiced or billed. */
  contractedAmountMinor: number;
  currency: string;
  issuedOn: ISODate | null;
  dueOn: ISODate;
  isSettled: boolean;
  /**
   * The day QuickBooks last changed the row.
   *
   * For a settled invoice this is when the payment was applied — UNLESS
   * somebody edited it afterwards, in which case it is the edit. QuickBooks
   * does not put the settlement date on the invoice itself; it lives on the
   * linked Payment, which is a second query per row. This is the best date
   * available without that, and it is recorded as an approximation rather than
   * presented as the payment date.
   */
  lastChangedOn: ISODate | null;
}

const OBLIGATION_ENTITIES: Array<{ entity: string; direction: TxnDirection }> = [
  // An invoice is money owed TO AHN.
  { entity: 'Invoice', direction: 'inflow' },
  // A bill is money AHN owes.
  { entity: 'Bill', direction: 'outflow' },
];

function isoDay(value: string | undefined): ISODate | null {
  if (!value) return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * Pull invoices and bills: everything currently open, plus anything that
 * changed recently.
 *
 * TWO QUERIES, AND THE REASON IS THE WHOLE POINT OF THIS FUNCTION.
 *
 * The transaction sync pulls incrementally from the last successful run,
 * because a transaction is immutable history — once written it never changes,
 * so anything older has already been seen. An accrual is not history. It is
 * live state: an invoice raised in June is still owed in September, and its
 * balance moves without its transaction date ever changing.
 *
 * Filtering these by `TxnDate >= since` was the first attempt, and against the
 * real company it returned nothing at all while QuickBooks held 31 invoices and
 * 15 bills — every one of them dated before the last sync. A sync that reports
 * "0 imported" with no error is the worst possible way to be wrong.
 *
 * So:
 *   1. `Balance > '0'` — every open item, however old. This is the live state
 *      that section 17 ages and chases.
 *   2. `MetaData.LastUpdatedTime >= since` — anything touched since the last
 *      run. Without this an invoice that got PAID would simply stop matching
 *      query 1, and the obligation already stored for it would sit open
 *      forever, ageing into the overdue bucket and being chased after it was
 *      settled. A row has to be told it was paid.
 *
 * They are separate calls because the QuickBooks query language has no `or`;
 * asking for one returns HTTP 400. Results are unioned on the row id.
 *
 * The value in `Balance > '0'` is quoted for the same reason: unquoted, the
 * parser rejects the statement.
 */
export async function fetchQboObligations(opts: {
  accessToken: string;
  realmId: string;
  since: ISODate;
}): Promise<QboObligation[]> {
  const out: QboObligation[] = [];

  for (const { entity, direction } of OBLIGATION_ENTITIES) {
    const [open, changed] = await Promise.all([
      queryAll<QboObligationRow>(opts.accessToken, opts.realmId, entity, "Balance > '0'"),
      queryAll<QboObligationRow>(
        opts.accessToken,
        opts.realmId,
        entity,
        `MetaData.LastUpdatedTime >= '${opts.since}T00:00:00+00:00'`,
      ),
    ]);

    const byId = new Map<string, QboObligationRow>();
    for (const row of [...open, ...changed]) byId.set(row.Id, row);
    const rows = [...byId.values()];

    for (const row of rows) {
      const currency = (row.CurrencyRef?.value ?? 'USD').toUpperCase();
      const total = Number(row.TotalAmt ?? 0);
      // `Balance` is absent on some rows; treating that as "nothing owed" would
      // silently settle a live invoice, so it falls back to the total.
      const balance = row.Balance === undefined ? total : Number(row.Balance);
      if (!Number.isFinite(total) || total <= 0) continue; // voided or empty

      const dueOn = isoDay(row.DueDate) ?? isoDay(row.TxnDate);
      // `due_on` is NOT NULL, and a due date is the whole basis of aging. A row
      // without one cannot be aged, so it is skipped rather than given a made-up
      // date that would put it in a bucket it does not belong in.
      if (!dueOn) continue;

      const party = direction === 'inflow' ? row.CustomerRef : row.VendorRef;

      out.push({
        externalId: `${entity}:${row.Id}`,
        direction,
        counterpartyName: party?.name?.trim() || null,
        reference: row.DocNumber?.trim() || null,
        description:
          row.CustomerMemo?.value?.trim() ||
          row.PrivateNote?.trim() ||
          row.Line?.find((l) => l.Description)?.Description?.trim() ||
          null,
        // What is owed now, which is what §17 and §18 age and chase.
        amountMinor: toMinor(Math.max(balance, 0), currency),
        // What was agreed, which is what the schema keeps alongside it.
        contractedAmountMinor: toMinor(total, currency),
        currency,
        issuedOn: isoDay(row.TxnDate),
        dueOn,
        isSettled: Math.abs(balance) < 0.005,
        lastChangedOn: isoDay(row.MetaData?.LastUpdatedTime),
      });
    }
  }

  return out;
}
