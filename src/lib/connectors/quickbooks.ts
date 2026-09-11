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
import { ProviderAuthError, asTransient, classifyIntuitFailure, withRetry } from '@/lib/connectors/retry';
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

/**
 * One token request, retried when — and only when — retrying could work.
 *
 * The classification lives in `retry.ts` because the distinction it draws is
 * the whole point: a 400 saying `invalid_grant` must NOT be retried (the
 * refresh token is dead, and Intuit asks apps not to hammer their token
 * endpoint with credentials they have already been told are gone), while a 503
 * must be.
 */
async function requestToken(body: URLSearchParams): Promise<TokenResponse> {
  return withRetry(async () => {
    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          authorization: basicAuthHeader(),
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
      });
    } catch (err) {
      // A thrown fetch is DNS, a reset connection or a timeout — always worth
      // another attempt, and never a reason to tell somebody to reconnect.
      throw asTransient('quickbooks', err);
    }

    if (!res.ok) throw classifyIntuitFailure(res.status, await res.text(), res.headers.get('intuit_tid'));
    return (await res.json()) as TokenResponse;
  });
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
 * Tell Intuit to forget the connection - the other half of disconnecting.
 *
 * WITHOUT THIS, "disconnect" IS A LIE. Deleting our copy of the token stops us
 * using it, and leaves the grant live on Intuit's side: the app keeps showing
 * in the company's Connected Apps and the token stays valid for anybody who
 * ever held it. The privacy policy promises the token is revoked, so it has to
 * actually be revoked.
 *
 * The refresh token is the one to send. Revoking it invalidates the whole
 * grant, including access tokens minted from it; revoking an access token
 * alone leaves the refresh token able to mint another.
 *
 * VERIFIED, not assumed. This endpoint answers 400 to a malformed token while a
 * made-up path under the same host answers 404 — so the 400 is the endpoint
 * rejecting the token, not the gateway rejecting the URL. That distinction is
 * exactly what the VEEM check got wrong (decision 94).
 */
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

export async function revokeTokens(refreshToken: string): Promise<void> {
  const res = await fetch(REVOKE_URL, {
    method: 'POST',
    headers: {
      authorization: basicAuthHeader(),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ token: refreshToken }),
  });

  // 400 means Intuit does not recognise the token — already revoked, or expired
  // after 101 days of disuse. Either way the grant is gone, which is the state
  // the caller wanted. Treating that as a failure would leave a dead row nobody
  // could ever delete.
  if (res.ok || res.status === 400) return;

  const tid = res.headers.get('intuit_tid');
  throw new Error(
    `QuickBooks refused to revoke the token (${res.status}): ${(await res.text()).slice(0, 200)}` +
      (tid ? ` [intuit_tid ${tid}]` : ''),
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
  options: { force?: boolean } = {},
): Promise<string> {
  if (!integration.access_token_enc || !integration.refresh_token_enc) {
    throw new Error('QuickBooks integration has no stored tokens. Reconnect it.');
  }

  const expiresAt = integration.token_expires_at
    ? new Date(integration.token_expires_at).getTime()
    : 0;

  // `force` exists for the case the stored expiry cannot see: Intuit has
  // invalidated the access token early, so our clock says "fine" and their
  // answer is 401. See `createQboSession`.
  if (!options.force && expiresAt > Date.now() + 60_000) {
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

/**
 * A run of QuickBooks calls that can survive an access token dying early.
 *
 * THE CASE THE EXPIRY CHECK CANNOT SEE. `getAccessToken` decides whether to
 * refresh by looking at the expiry we stored when the token was issued. That is
 * right almost always, and blind to the times Intuit invalidates an access
 * token BEFORE its stated expiry — a password change, a security event on the
 * Intuit account, or our stored timestamp drifting. Our clock says the token
 * has forty minutes left; Intuit answers 401.
 *
 * Without this, that 401 was classified `reconnect` and the customer was told
 * to authorise again — when the refresh token was sitting right there, valid,
 * and one call away from fixing it. The advice was wrong AND expensive: a
 * reconnect is a manual OAuth round trip somebody has to go and do.
 *
 * So a 401 buys exactly one forced refresh and one retry. If the refresh itself
 * comes back `invalid_grant`, or the retry is refused again, then the grant
 * really is gone and `reconnect` is the honest answer.
 *
 * THE ROTATION TRAP. Intuit issues a NEW refresh token on every refresh and
 * invalidates the old one. The `Integration` handed in here is a snapshot, and
 * nothing updates it — so a second refresh that read `integration` again would
 * present the token Intuit has already retired, get `invalid_grant`, and report
 * "reconnect" for a connection that was perfectly healthy. That is the bug this
 * closure exists to prevent: `current` tracks every rotation in memory, so the
 * forced refresh always presents the token Intuit last issued.
 */
export function createQboSession(
  integration: Integration,
  persist: (tokens: {
    access_token_enc: string;
    refresh_token_enc: string;
    token_expires_at: string;
  }) => Promise<void>,
) {
  let current: Integration = integration;

  const track = async (tokens: {
    access_token_enc: string;
    refresh_token_enc: string;
    token_expires_at: string;
  }) => {
    current = { ...current, ...tokens };
    await persist(tokens);
  };

  return {
    /** The refresh token as it stands now, rotations included. */
    get integration(): Integration {
      return current;
    },

    async run<T>(fn: (accessToken: string) => Promise<T>): Promise<T> {
      const token = await getAccessToken(current, track);
      try {
        return await fn(token);
      } catch (err) {
        // Only a 401 is worth a second look. A 403 is a scope problem and a 429
        // has already been retried inside `withRetry`.
        if (!(err instanceof ProviderAuthError) || err.status !== 401) throw err;

        // Mint a new one from the CURRENT refresh token and try once more. If
        // this throws, it throws a properly classified error of its own.
        const fresh = await getAccessToken(current, track, { force: true });
        return fn(fresh);
      }
    },
  };
}

// ─── Query API ──────────────────────────────────────────────────────────────

async function query<T>(
  accessToken: string,
  realmId: string,
  statement: string,
  entity: string,
): Promise<T[]> {
  const url = `${qboApiBase()}/v3/company/${realmId}/query?query=${encodeURIComponent(statement)}&minorversion=70`;

  return withRetry(async () => {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      });
    } catch (err) {
      throw asTransient('quickbooks', err);
    }

    // A 401 is classified `reconnect`, but it does not reach a person as one
    // straight away: `createQboSession` intercepts the first 401, forces a
    // refresh, and retries. Only a 401 that survives a freshly minted token is
    // really a dead grant. Classifying it here and deciding there keeps the
    // "what did Intuit say" and "what should we do about it" judgements apart.
    if (!res.ok) throw classifyIntuitFailure(res.status, await res.text(), res.headers.get('intuit_tid'));

    const json = (await res.json()) as { QueryResponse?: Record<string, T[]> };
    return json.QueryResponse?.[entity] ?? [];
  });
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
export interface QboRow {
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
  /** Entities already known to be missing from this subscription — not asked for. */
  skip?: readonly string[];
  /** Collects entities this subscription turned out not to include. */
  unavailable?: string[];
}

/**
 * Pull one entity, treating "your subscription does not include this" as an
 * answer rather than a failure.
 *
 * QUICKBOOKS EDITIONS ARE NOT THE SAME PRODUCT. Simple Start has no bills and
 * no bill payments; asking it for either is refused with code 5030. Before
 * this, that refusal escaped `fetchQboTransactions` and failed the WHOLE sync —
 * so a Simple Start customer got no purchases, deposits or payments either,
 * over data they never had. Now the missing entity is skipped and reported, and
 * everything the subscription does include still arrives.
 *
 * Only `unavailable` is absorbed. An auth failure still propagates, because
 * that one needs a person.
 */
export async function forEntity<T>(
  entity: string,
  unavailable: string[] | undefined,
  run: () => Promise<T[]>,
): Promise<T[]> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ProviderAuthError && err.kind === 'unavailable') {
      if (unavailable && !unavailable.includes(entity)) unavailable.push(entity);
      return [];
    }
    throw err;
  }
}

/**
 * One QuickBooks cash row as a ledger transaction, or null if it carries no
 * amount. Shared by the query path and CDC so the two cannot disagree about
 * what a row means.
 */
export function normaliseCashRow(
  entity: string,
  direction: TxnDirection,
  row: QboRow,
  accountIdFor: QboSyncOptions['accountIdFor'],
  fallbackDate: ISODate,
): NormalizedTransaction | null {
  const amount = parseAmount(row.TotalAmt ?? null);
  if (amount === null) return null;

  const currency = (row.CurrencyRef?.value ?? 'USD').toUpperCase();
  const qboAccount =
    row.AccountRef ?? row.DepositToAccountRef ?? row.Line?.[0]?.DepositLineDetail?.AccountRef ?? null;

  const counterparty = row.EntityRef?.name ?? row.VendorRef?.name ?? row.CustomerRef?.name ?? null;

  const lineCategory = row.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef?.name ?? null;

  return {
    account_id: accountIdFor(qboAccount?.value ?? null, qboAccount?.name ?? null),
    txn_date: row.TxnDate ?? fallbackDate,
    posted_at: row.MetaData?.CreateTime ?? null,
    // QBO reports magnitudes; the entity type carries the direction.
    amount_minor: toMinor(Math.abs(amount), currency),
    currency,
    direction,
    description: row.PrivateNote ?? row.Line?.[0]?.Description ?? `${entity} ${row.Id}`,
    counterparty_name: counterparty,
    // The ledger account name is a better category than any guess we make.
    subcategory: lineCategory,
    source_system: 'quickbooks',
    external_txn_id: `${entity}:${row.Id}`,
    raw: row as unknown as Record<string, unknown>,
  };
}

/** Pull cash-affecting transactions and normalise them for `ingestTransactions`. */
export async function fetchQboTransactions(
  options: QboSyncOptions,
): Promise<NormalizedTransaction[]> {
  const out: NormalizedTransaction[] = [];

  for (const { entity, direction } of CASH_ENTITIES) {
    if (options.skip?.includes(entity)) continue;

    const rows = await forEntity(entity, options.unavailable, () =>
      queryAll<QboRow>(options.accessToken, options.realmId, entity, `TxnDate >= '${options.since}'`),
    );

    for (const row of rows) {
      const txn = normaliseCashRow(entity, direction, row, options.accountIdFor, options.since);
      if (txn) out.push(txn);
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
/**
 * One QuickBooks invoice or bill as an obligation, or null when it cannot be
 * aged. Shared by the query path and CDC.
 */
export function normaliseObligationRow(
  entity: string,
  direction: TxnDirection,
  row: QboObligationRow,
): QboObligation | null {
  const currency = (row.CurrencyRef?.value ?? 'USD').toUpperCase();
  const total = Number(row.TotalAmt ?? 0);
  // `Balance` is absent on some rows; treating that as "nothing owed" would
  // silently settle a live invoice, so it falls back to the total.
  const balance = row.Balance === undefined ? total : Number(row.Balance);
  if (!Number.isFinite(total) || total <= 0) return null; // voided or empty

  const dueOn = isoDay(row.DueDate) ?? isoDay(row.TxnDate);
  // `due_on` is NOT NULL, and a due date is the whole basis of aging. A row
  // without one cannot be aged, so it is skipped rather than given a made-up
  // date that would put it in a bucket it does not belong in.
  if (!dueOn) return null;

  const party = direction === 'inflow' ? row.CustomerRef : row.VendorRef;

  return {
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
  };
}

// ─── Change Data Capture ────────────────────────────────────────────────────

/**
 * The entities CDC carries: the cash ledger and the obligations.
 *
 * Account is deliberately NOT here. Its `CurrentBalance` moves whenever a
 * transaction posts, and that does not reliably bump the Account's own
 * `LastUpdatedTime` — so a CDC-only view of accounts would freeze the "Provider
 * says" balance that reconciliation compares against. It stays one query.
 */
export const CDC_ENTITIES: ReadonlyArray<{ entity: string; direction: TxnDirection; kind: 'cash' | 'obligation' }> = [
  ...CASH_ENTITIES.map((e) => ({ ...e, kind: 'cash' as const })),
  ...OBLIGATION_ENTITIES.map((e) => ({ ...e, kind: 'obligation' as const })),
];

/**
 * CDC looks back at most 30 days. One day of margin, so a sync that lands on
 * the boundary is not refused for asking about day 30 and a few seconds.
 */
export const CDC_MAX_LOOKBACK_DAYS = 29;

/**
 * The most objects CDC will return in one response. Anything at or above this
 * is treated as possibly cut off — see `truncated`.
 */
export const CDC_RESPONSE_CAP = 1000;

export interface QboChangeSet {
  /** Entity name -> rows created or changed since `changedSince`. */
  changed: Record<string, QboRow[]>;
  /** Entity name -> ids deleted since `changedSince`. */
  deleted: Record<string, string[]>;
  /**
   * True when the response might be incomplete. The caller must then fall back
   * to the query path: trusting a cut-off change set is how rows go missing
   * without anybody being told.
   */
  truncated: boolean;
  /** Objects in the response, deleted ones included. */
  size: number;
}

/**
 * Everything that changed since a moment, in one call — Intuit's recommended
 * way to stay in sync.
 *
 * WHY IT REPLACED THE PER-ENTITY QUERIES FOR INCREMENTAL SYNCS
 *
 *   1. It sees DELETIONS. The query path asks `TxnDate >= since`, and a deleted
 *      transaction matches nothing — so a purchase deleted in QuickBooks stayed
 *      in AHN's ledger forever, counted as cash that had left. CDC returns it
 *      with `status: "Deleted"`, and the sync removes it.
 *   2. It sees EDITS TO OLD ROWS. `TxnDate >= since` only reaches back seven
 *      days; an invoice from March corrected today was invisible. CDC keys on
 *      when the object changed, not on the date printed on it.
 *   3. One call instead of eight. Six entities, one request.
 *
 * The response shape is Intuit's `CDCResponse`, taken from the XSD in their
 * own Java SDK rather than from a blog post: an array of `QueryResponse`
 * blocks, one per entity, or a `Fault`. A deleted object carries
 * `status="Deleted"` and little else.
 */
export async function fetchQboChanges(
  accessToken: string,
  realmId: string,
  entities: readonly string[],
  changedSince: Date,
): Promise<QboChangeSet> {
  // Intuit's documented form is `2012-07-20T22:25:51-07:00`. The `+` in a UTC
  // offset MUST be percent-encoded: left raw in a query string it arrives as a
  // space, and the timestamp is rejected — or worse, misread.
  const since = `${changedSince.toISOString().slice(0, 19)}+00:00`;
  const url =
    `${qboApiBase()}/v3/company/${realmId}/cdc` +
    `?entities=${encodeURIComponent(entities.join(','))}` +
    `&changedSince=${encodeURIComponent(since)}&minorversion=70`;

  let cdcTid: string | null = null;
  const json = await withRetry(async () => {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      });
    } catch (err) {
      throw asTransient('quickbooks', err);
    }
    if (!res.ok) throw classifyIntuitFailure(res.status, await res.text(), res.headers.get('intuit_tid'));
    cdcTid = res.headers.get('intuit_tid');
    return (await res.json()) as {
      CDCResponse?: Array<{
        QueryResponse?: Array<Record<string, unknown>>;
        Fault?: unknown;
      }>;
      Fault?: unknown;
    };
  });

  // A fault can arrive inside a 200. Reading only the status code would take
  // "your subscription does not include Bill" as "nothing changed".
  const fault = json.Fault ?? json.CDCResponse?.find((b) => b.Fault)?.Fault;
  if (fault) throw classifyIntuitFailure(400, JSON.stringify({ Fault: fault }), cdcTid);

  const out: QboChangeSet = { changed: {}, deleted: {}, truncated: false, size: 0 };

  for (const block of json.CDCResponse ?? []) {
    for (const response of block.QueryResponse ?? []) {
      for (const entity of entities) {
        const rows = response[entity];
        if (!Array.isArray(rows)) continue;

        for (const row of rows as Array<QboRow & { status?: string }>) {
          out.size++;
          if (row.status === 'Deleted') {
            (out.deleted[entity] ??= []).push(String(row.Id));
          } else {
            (out.changed[entity] ??= []).push(row);
          }
        }

        // A block that says more exist than it carried was cut off.
        const total = Number(response.totalCount);
        if (Number.isFinite(total) && total > rows.length) out.truncated = true;
      }
    }
  }

  if (out.size >= CDC_RESPONSE_CAP) out.truncated = true;
  return out;
}

// ─── Choosing how to sync ───────────────────────────────────────────────────

/**
 * How long an entity the subscription lacks is left alone before being asked
 * for again.
 *
 * Customers change QuickBooks editions whenever they like. Remembering "Simple
 * Start has no bills" forever would mean an upgrade to Essentials was never
 * noticed; asking every ten minutes would mean a refused request on every tick.
 * Once a day notices an upgrade within a day, at the cost of one extra refusal.
 */
export const UNAVAILABLE_RECHECK_MS = 24 * 60 * 60 * 1000;

/**
 * CDC's `changedSince` is set this far before the last successful sync.
 *
 * `last_synced_at` is stamped when a sync FINISHES, so anything changed in
 * QuickBooks while that sync was running would sit just before the next
 * window and be missed. The overlap costs nothing: re-ingesting a row already
 * held is a no-op.
 */
export const CDC_OVERLAP_MS = 60 * 60 * 1000;

/** Entity name -> ISO time it was found missing from this subscription. */
export type UnavailableMap = Record<string, string>;

export interface QboSyncPlan {
  path: 'cdc' | 'query';
  /** Entities not to ask for this time — known missing, and not yet due a re-check. */
  skip: string[];
  changedSince: Date | null;
  /** One line a person can read, for logs and the sync result. */
  reason: string;
}

/**
 * Decide between CDC and the full query path. Pure, so every branch is tested
 * without a network.
 *
 * The query path is the safe one — it re-reads six months and isolates each
 * entity — so every doubt resolves towards it:
 *   - never synced                → query (CDC has no history to offer)
 *   - last sync > 29 days ago     → query (outside CDC's 30-day window)
 *   - a missing entity is due a re-check → query (so a newly available entity
 *     arrives with its history, not just changes from this minute on)
 *   - otherwise                   → CDC
 */
export function planQboSync(input: {
  lastSyncedAt: string | null;
  unavailable: UnavailableMap;
  now: Date;
}): QboSyncPlan {
  const now = input.now.getTime();
  const skip: string[] = [];
  const due: string[] = [];
  for (const [entity, markedAt] of Object.entries(input.unavailable)) {
    const age = now - new Date(markedAt).getTime();
    if (Number.isFinite(age) && age < UNAVAILABLE_RECHECK_MS) skip.push(entity);
    else due.push(entity);
  }

  if (!input.lastSyncedAt) {
    return { path: 'query', skip, changedSince: null, reason: 'first sync — full history' };
  }

  const last = new Date(input.lastSyncedAt).getTime();
  if (!Number.isFinite(last) || now - last > CDC_MAX_LOOKBACK_DAYS * 86_400_000) {
    return { path: 'query', skip, changedSince: null, reason: 'last sync is outside the CDC window' };
  }

  if (due.length > 0) {
    return {
      path: 'query',
      skip,
      changedSince: null,
      reason: `re-checking whether the subscription now includes ${due.join(', ')}`,
    };
  }

  return {
    path: 'cdc',
    skip,
    changedSince: new Date(last - CDC_OVERLAP_MS),
    reason: 'incremental — changes since the last sync',
  };
}

/**
 * What to remember about missing entities after a sync.
 *
 *   - skipped this time      → keep the original mark, so the 24-hour clock is
 *                              not reset by not asking
 *   - refused this time      → marked now
 *   - asked and answered     → forgotten: the customer has the feature now
 */
export function nextUnavailable(
  previous: UnavailableMap,
  skipped: readonly string[],
  refused: readonly string[],
  now: Date,
): UnavailableMap {
  const next: UnavailableMap = {};
  for (const entity of skipped) {
    const mark = previous[entity];
    if (mark) next[entity] = mark;
  }
  for (const entity of refused) next[entity] = now.toISOString();
  return next;
}

export async function fetchQboObligations(opts: {
  accessToken: string;
  realmId: string;
  since: ISODate;
  skip?: readonly string[];
  unavailable?: string[];
}): Promise<QboObligation[]> {
  const out: QboObligation[] = [];

  for (const { entity, direction } of OBLIGATION_ENTITIES) {
    if (opts.skip?.includes(entity)) continue;

    const [open, changed] = await Promise.all([
      forEntity(entity, opts.unavailable, () =>
        queryAll<QboObligationRow>(opts.accessToken, opts.realmId, entity, "Balance > '0'"),
      ),
      forEntity(entity, opts.unavailable, () =>
        queryAll<QboObligationRow>(
          opts.accessToken,
          opts.realmId,
          entity,
          `MetaData.LastUpdatedTime >= '${opts.since}T00:00:00+00:00'`,
        ),
      ),
    ]);

    const byId = new Map<string, QboObligationRow>();
    for (const row of [...open, ...changed]) byId.set(row.Id, row);

    for (const row of byId.values()) {
      const obligation = normaliseObligationRow(entity, direction, row);
      if (obligation) out.push(obligation);
    }
  }

  return out;
}
