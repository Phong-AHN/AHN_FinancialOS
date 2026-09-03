/**
 * Finverse - Spec section 2, the Vietnamese bank route.
 *
 * Neither Vietnamese bank AHN banks with can be reached directly today:
 * VietinBank's sandbox needs a registered application, and Techcombank has no
 * public self-serve sandbox at all. Finverse is an aggregator that already
 * covers Techcombank, Vietcombank and VP Bank, and it publishes a versioned
 * client library - so this file is written against a contract that was read,
 * not guessed.
 *
 * Shapes below come from `finversetech/sdk-typescript`: the operation paths in
 * `api.ts` and the response fixtures in `test/responses`.
 *
 * THE FLOW:
 *   1. `POST /auth/customer/token` with the client id and secret -> a bearer
 *      token, good for `expires_in` seconds.
 *   2. `POST /link/token` -> a hosted URL. A person signs in to their bank
 *      there; Finverse never gives us the bank credentials, which is the whole
 *      reason to use an aggregator rather than storing them ourselves.
 *   3. That produces a LOGIN IDENTITY, whose own token authorises the data
 *      calls: `GET /accounts` and `GET /transactions`.
 *   4. `POST /login_identity/refresh` asks Finverse to re-pull from the bank.
 */

import type { NormalizedTransaction, TxnDirection } from '@/lib/types';
import { parseAmount, toMinor } from '@/lib/money';

export type FinverseEnvironment = 'sandbox' | 'production';

const BASES: Record<FinverseEnvironment, string> = {
  sandbox: 'https://api.sandbox.finverse.net',
  production: 'https://api.prod.finverse.net',
};

export function finverseConfigured(): boolean {
  return Boolean(process.env.FINVERSE_CLIENT_ID && process.env.FINVERSE_CLIENT_SECRET);
}

export function finverseEnvironment(): FinverseEnvironment {
  return process.env.FINVERSE_ENV === 'production' ? 'production' : 'sandbox';
}

export function finverseBase(): string {
  return BASES[finverseEnvironment()];
}

/**
 * Everything wrong with the configuration, as sentences rather than a boolean.
 *
 * The same pattern as the other connectors: an integration that reports
 * "not connected" without saying which of four things is missing costs an hour
 * of guessing every time.
 */
export function finverseConfigProblems(): string[] {
  const problems: string[] = [];
  if (!process.env.FINVERSE_CLIENT_ID) problems.push('FINVERSE_CLIENT_ID is not set.');
  if (!process.env.FINVERSE_CLIENT_SECRET) problems.push('FINVERSE_CLIENT_SECRET is not set.');

  const env = process.env.FINVERSE_ENV;
  if (env && env !== 'sandbox' && env !== 'production') {
    problems.push(`FINVERSE_ENV must be "sandbox" or "production", not "${env}".`);
  }

  if (!process.env.FINVERSE_REDIRECT_URI) {
    problems.push(
      'FINVERSE_REDIRECT_URI is not set. The Link flow returns the person to it after they sign in at their bank, and it has to match the URI registered with Finverse exactly.',
    );
  }
  return problems;
}

// ─── Authentication ─────────────────────────────────────────────────────────

export interface CustomerToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Server-to-server token: `POST /auth/customer/token`, client credentials.
 *
 * `expires_in` is seconds from now. It is converted to an absolute moment here
 * because a duration is only meaningful at the instant it was issued, and this
 * value gets stored and read back much later.
 */
export async function fetchCustomerToken(): Promise<CustomerToken> {
  const res = await fetch(`${finverseBase()}/auth/customer/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.FINVERSE_CLIENT_ID,
      client_secret: process.env.FINVERSE_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) {
    throw new Error(`Finverse token request failed: ${res.status} ${await safeBody(res)}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in?: number };
  if (!json.access_token) throw new Error('Finverse returned no access token.');

  return {
    accessToken: json.access_token,
    // A minute of headroom, so a token does not expire between the check and
    // the call it was fetched for.
    expiresAt: Date.now() + ((json.expires_in ?? 3600) - 60) * 1000,
  };
}

/**
 * A hosted Link URL - `POST /link/token`.
 *
 * `userId` identifies the person on our side so a re-link updates the existing
 * connection instead of creating a second one for the same bank.
 */
export async function createLinkToken(
  token: string,
  userId: string,
): Promise<{ linkUrl: string; linkToken: string }> {
  const res = await fetch(`${finverseBase()}/link/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      client_id: process.env.FINVERSE_CLIENT_ID,
      user_id: userId,
      redirect_uri: process.env.FINVERSE_REDIRECT_URI,
      response_mode: 'form_post',
      response_type: 'code',
      grant_type: 'client_credentials',
      state: userId,
    }),
  });

  if (!res.ok) {
    throw new Error(`Finverse link token failed: ${res.status} ${await safeBody(res)}`);
  }

  const json = (await res.json()) as { link_url?: string; access_token?: string };
  if (!json.link_url) throw new Error('Finverse returned no link URL.');
  return { linkUrl: json.link_url, linkToken: json.access_token ?? '' };
}

// ─── Accounts ───────────────────────────────────────────────────────────────

export interface FinverseAmount {
  currency?: string;
  value: number;
  /** The exact figure as a string, e.g. "15000.00". Preferred over `value`. */
  raw?: string;
}

export interface FinverseAccount {
  account_id: string;
  account_name: string;
  /** Sent by Finverse; declared so the type matches the payload. */
  group_id?: string;
  is_parent?: boolean;
  created_at?: string;
  updated_at?: string;
  statement_balance?: FinverseAmount;
  ledger_balance?: FinverseAmount;
  metadata?: Record<string, string>;
  account_nickname?: string;
  account_number_masked?: string;
  account_currency?: string;
  balance?: FinverseAmount;
  is_closed: boolean;
  is_excluded: boolean;
  account_type?: { type?: string; subtype?: string };
}

export interface MappedFinverseAccount {
  type: string;
  /** Whether the balance belongs in "how much cash do we have?". */
  countsAsCash: boolean;
}

/**
 * Finverse account subtype -> our account_type, and whether it is cash.
 *
 * The default is deliberately NOT cash, and this is the second time that rule
 * has had to be written down. A Plaid connection once put a mortgage, a student
 * loan, an auto loan, a HELOC, a 401k and an IRA into the headline cash figure
 * - $182,228 of borrowings and locked-up money reported as spendable, because
 * an unrecognised type fell through to "other" and "other" counted as cash.
 *
 * Overstating what a company can spend is the dangerous direction. A balance
 * wrongly left out shows on the Accounts page, where a person can turn it back
 * on; a debt wrongly added to cash shows nowhere at all.
 */
export function mapFinverseAccountType(subtype: string | null | undefined): MappedFinverseAccount {
  switch ((subtype ?? '').toUpperCase()) {
    case 'CURRENT':
    case 'DEBIT_CARD':
      return { type: 'checking', countsAsCash: true };
    case 'SAVINGS':
    case 'TIME_DEPOSIT':
      return { type: 'savings', countsAsCash: true };

    // Money owed, not money held. Finverse reports these as positive balances
    // exactly as Plaid does.
    case 'CREDIT_CARD':
      return { type: 'credit_card', countsAsCash: false };
    case 'MORTGAGE':
    case 'PERSONAL_LOAN':
    case 'REVOLVING_LOAN':
      return { type: 'loan', countsAsCash: false };

    // Real value, but not what the company can pay a supplier with this week.
    case 'SECURITIES':
    case 'FUNDS':
    case 'STOCKS':
    case 'BONDS':
      return { type: 'investment', countsAsCash: false };

    default:
      return { type: 'other', countsAsCash: false };
  }
}

export async function fetchAccounts(loginIdentityToken: string): Promise<FinverseAccount[]> {
  const res = await fetch(`${finverseBase()}/accounts`, {
    headers: { authorization: `Bearer ${loginIdentityToken}` },
  });
  if (!res.ok) {
    throw new Error(`Finverse accounts failed: ${res.status} ${await safeBody(res)}`);
  }
  const json = (await res.json()) as { accounts?: FinverseAccount[] };
  return json.accounts ?? [];
}

// ─── Transactions ───────────────────────────────────────────────────────────

export interface FinverseTransaction {
  transaction_id: string;
  account_id: string;
  amount?: FinverseAmount;
  description?: string;
  merchant_name?: string;
  posted_date?: string;
  transaction_time?: string | null;
  transaction_reference?: string;
  is_pending: boolean;
  categories?: string[];

  /**
   * Sent by Finverse and deliberately unused.
   *
   * Declared so the shape matches what actually arrives - a contract test
   * against the vendor's own fixture caught `created_at` missing from here, and
   * a type that quietly disagrees with the payload is a type that stops being
   * checked.
   *
   * `categories` is Finverse's own classification; ours runs on the description
   * instead, because it already knows AHN's vendors and Vietnamese statement
   * wording, and two categorisers disagreeing silently is worse than one.
   */
  created_at?: string;
  updated_at?: string;
  transaction_state?: string;
  transaction_type?: string;
  status?: string;
  running_balance?: FinverseAmount;
}

/** The page size the API documents as its maximum. */
const PAGE_LIMIT = 1000;

/**
 * Every transaction for a login identity, following the offset pages.
 *
 * `enrichments=false` asks for the raw bank rows. The enriched ones carry
 * Finverse's own categories, which we do not want as the source of truth: our
 * category rules already understand AHN's vendors and Vietnamese statement
 * wording, and two categorisers disagreeing silently is worse than one.
 */
export async function fetchTransactions(
  loginIdentityToken: string,
  options: { maxPages?: number } = {},
): Promise<FinverseTransaction[]> {
  const maxPages = options.maxPages ?? 20;
  const all: FinverseTransaction[] = [];

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${finverseBase()}/transactions`);
    url.searchParams.set('offset', String(page * PAGE_LIMIT));
    url.searchParams.set('limit', String(PAGE_LIMIT));
    url.searchParams.set('enrichments', 'false');

    const res = await fetch(url, { headers: { authorization: `Bearer ${loginIdentityToken}` } });
    if (!res.ok) {
      throw new Error(`Finverse transactions failed: ${res.status} ${await safeBody(res)}`);
    }

    const json = (await res.json()) as { transactions?: FinverseTransaction[] };
    const batch = json.transactions ?? [];
    all.push(...batch);
    if (batch.length < PAGE_LIMIT) break;
  }

  return all;
}

/**
 * Finverse amount -> minor units, exactly.
 *
 * `raw` is preferred over `value` whenever it is present, and that is not
 * fussiness: `raw` is the figure as a STRING ("15000.00"), while `value` is a
 * JSON number that has already been through a float. For a VND balance in the
 * hundreds of millions that difference is real money, and the whole ledger is
 * built on never letting a float hold one.
 *
 * The currency decides the scale. VND has no minor unit, so 412,500,000 dong is
 * 412500000 - not 41250000000.
 */
export function amountToMinor(amount: FinverseAmount | undefined, currency: string): number | null {
  if (!amount) return null;

  if (typeof amount.raw === 'string' && amount.raw.trim()) {
    const parsed = parseAmount(amount.raw, { currency });
    if (parsed !== null) return toMinor(parsed, currency);
  }

  if (typeof amount.value === 'number' && Number.isFinite(amount.value)) {
    return toMinor(amount.value, currency);
  }
  return null;
}

/** Finverse signs its amounts: money leaving the account is negative. */
export function toDirection(signedMinor: number): TxnDirection {
  return signedMinor < 0 ? 'outflow' : 'inflow';
}

export interface NormalizeOptions {
  /** Finverse account id -> our `financial_accounts.id`. */
  accountMap: Map<string, string>;
  /** Finverse account id -> that account's currency. */
  currencyMap: Map<string, string>;
  /** Pending rows change and disappear; excluded by default. */
  includePending?: boolean;
}

export interface NormalizeResult {
  rows: NormalizedTransaction[];
  skippedPending: number;
  skippedUnknownAccount: number;
  skippedNoAmount: number;
}

/**
 * Finverse rows -> our ledger shape.
 *
 * Three reasons a row is dropped rather than guessed at, each counted so a sync
 * can report what it did not take:
 *
 *   - PENDING. A pending transaction can change amount, change date or vanish.
 *     Booking one means the ledger disagrees with the bank a day later, and the
 *     reconcile page then reports a variance nobody can explain.
 *   - UNKNOWN ACCOUNT. A transaction whose account we never mapped has no home;
 *     inventing one would put real money in the wrong place.
 *   - NO AMOUNT. A row without a parseable amount is not a zero-value
 *     transaction, it is a row we failed to read.
 */
export function normalizeTransactions(
  transactions: FinverseTransaction[],
  options: NormalizeOptions,
): NormalizeResult {
  const result: NormalizeResult = {
    rows: [],
    skippedPending: 0,
    skippedUnknownAccount: 0,
    skippedNoAmount: 0,
  };

  for (const t of transactions) {
    if (t.is_pending && !options.includePending) {
      result.skippedPending++;
      continue;
    }

    const ourAccountId = options.accountMap.get(t.account_id);
    if (!ourAccountId) {
      result.skippedUnknownAccount++;
      continue;
    }

    const currency = (
      t.amount?.currency ??
      options.currencyMap.get(t.account_id) ??
      'USD'
    ).toUpperCase();

    const signedMinor = amountToMinor(t.amount, currency);
    if (signedMinor === null) {
      result.skippedNoAmount++;
      continue;
    }

    const direction = toDirection(signedMinor);

    result.rows.push({
      account_id: ourAccountId,
      txn_date: t.posted_date ?? (t.transaction_time ?? '').slice(0, 10),
      posted_at: t.transaction_time ?? null,
      // The column is checked `>= 0`; the sign lives in `direction`, so that no
      // figure in the ledger can be negative in one place and positive in
      // another and still add up.
      amount_minor: Math.abs(signedMinor),
      currency,
      direction,
      description: t.description ?? t.merchant_name ?? null,
      counterparty_name: t.merchant_name ?? null,
      source_system: 'finverse',
      external_txn_id: t.transaction_id,
      raw: t as unknown as Record<string, unknown>,
    });
  }

  return result;
}

/** Ask Finverse to re-pull from the bank - `POST /login_identity/refresh`. */
export async function refreshLoginIdentity(
  token: string,
  loginIdentityId: string,
): Promise<boolean> {
  const res = await fetch(`${finverseBase()}/login_identity/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ login_identity_id: loginIdentityId }),
  });
  return res.ok;
}

async function safeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '(no body)';
  }
}
