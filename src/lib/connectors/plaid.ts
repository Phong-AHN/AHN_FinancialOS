/**
 * Plaid connector - MVP Plan Day 3 (US bank accounts and credit cards).
 *
 * Uses /transactions/sync rather than /transactions/get: it is cursor-based, so
 * each poll returns only what changed, and it reports removals explicitly. A
 * five-minute cron over /transactions/get would re-pull the same 90 days
 * forever and lean entirely on the dedup key to stay correct.
 *
 * Plaid sign convention: amount is POSITIVE when money leaves the account and
 * NEGATIVE when it arrives. That is the opposite of the intuitive reading, and
 * getting it backwards would invert every inflow and outflow in the product -
 * hence the explicit mapping in `toDirection` below.
 */

import { toMinor } from '@/lib/money';
import type { NormalizedTransaction, TxnDirection } from '@/lib/types';

export function plaidConfigured(): boolean {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

/**
 * Plaid has two live environments: `sandbox` and `production`.
 *
 * It used to have a third, `development`, which allowed up to 100 real bank
 * connections without going through Production approval. That environment has
 * been retired and `development.plaid.com` no longer resolves at all - a request
 * to it fails with a DNS error that says nothing about the real cause.
 *
 * This matters for planning, not just for config: reaching AHN's real US bank
 * accounts now requires Plaid Production access, which is an application with a
 * review, not a self-serve toggle. Sandbox proves the whole pipeline today with
 * simulated banks; only Production carries real money.
 */
export type PlaidEnvironment = 'sandbox' | 'production';

export interface PlaidEnvCheck {
  environment: PlaidEnvironment;
  valid: boolean;
  rawValue: string | null;
  /** True while pointed at simulated data rather than real accounts. */
  isSimulated: boolean;
}

export function plaidEnvironment(): PlaidEnvCheck {
  const raw = process.env.PLAID_ENV?.trim().toLowerCase() ?? null;
  if (raw === 'sandbox' || raw === 'production') {
    return { environment: raw, valid: true, rawValue: raw, isSimulated: raw === 'sandbox' };
  }
  // Default to sandbox, never production: an unclear config must not be the
  // reason a live banking call goes out.
  return {
    environment: 'sandbox',
    valid: raw === null,
    rawValue: raw,
    isSimulated: true,
  };
}

function plaidBase(): string {
  return `https://${plaidEnvironment().environment}.plaid.com`;
}

/** Everything wrong with the Plaid configuration, stated plainly. */
export function plaidConfigProblems(): string[] {
  const problems: string[] = [];
  if (!process.env.PLAID_CLIENT_ID) problems.push('PLAID_CLIENT_ID is not set.');
  if (!process.env.PLAID_SECRET) problems.push('PLAID_SECRET is not set.');

  const env = plaidEnvironment();
  if (!env.valid && env.rawValue === 'development') {
    problems.push(
      'PLAID_ENV is "development", an environment Plaid has retired — development.plaid.com no longer resolves. Use "sandbox" to test the pipeline, or "production" once Plaid approves production access for real bank data.',
    );
  } else if (!env.valid) {
    problems.push(
      `PLAID_ENV is "${env.rawValue}", which is not a Plaid environment. Use "sandbox" or "production".`,
    );
  }
  return problems;
}

async function plaidPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${plaidBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.PLAID_CLIENT_ID,
      secret: process.env.PLAID_SECRET,
      ...body,
    }),
  });
  const json = (await res.json()) as T & { error_message?: string; error_code?: string };
  if (!res.ok) {
    throw new Error(`Plaid ${path} failed: ${json.error_code ?? res.status} ${json.error_message ?? ''}`);
  }
  return json;
}

// ─── Link ───────────────────────────────────────────────────────────────────

export async function createLinkToken(userId: string): Promise<string> {
  const json = await plaidPost<{ link_token: string }>('/link/token/create', {
    user: { client_user_id: userId },
    client_name: 'AHN Financial OS',
    products: ['transactions'],
    country_codes: ['US'],
    language: 'en',
  });
  return json.link_token;
}

export async function exchangePublicToken(
  publicToken: string,
): Promise<{ access_token: string; item_id: string }> {
  return plaidPost('/item/public_token/exchange', { public_token: publicToken });
}

// ─── Accounts ───────────────────────────────────────────────────────────────

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  balances: {
    current: number | null;
    available: number | null;
    iso_currency_code: string | null;
  };
}

export async function fetchAccounts(accessToken: string): Promise<PlaidAccount[]> {
  const json = await plaidPost<{ accounts: PlaidAccount[] }>('/accounts/balance/get', {
    access_token: accessToken,
  });
  return json.accounts;
}

export interface MappedAccount {
  type: string;
  /** Whether the balance belongs in "how much cash do we have?". */
  countsAsCash: boolean;
}

/**
 * Plaid account type -> our account_type, and whether it is cash.
 *
 * Plaid returns six types: depository, credit, loan, investment, brokerage,
 * other. The mapping used to send everything outside depository/credit to
 * `other`, and `other` counted as cash — so a mortgage, a student loan, an auto
 * loan, a HELOC, a 401k and an IRA all landed in the headline cash figure.
 *
 * Loans are the worst of it: Plaid reports the balance OWED as a POSITIVE
 * number, so debt INFLATED cash. One sandbox connection added $182,228 of
 * borrowings and locked-up investments to the answer.
 *
 * An unrecognised type is deliberately NOT cash. Overstating what a company can
 * spend is the dangerous direction, and a balance wrongly left out is visible on
 * the Accounts page, where a person can turn it back on.
 */
export function mapAccountType(type: string, subtype: string | null): MappedAccount {
  switch (type) {
    case 'credit':
      return { type: 'credit_card', countsAsCash: false };
    case 'loan':
      return { type: 'loan', countsAsCash: false };
    case 'investment':
    case 'brokerage':
      return { type: 'investment', countsAsCash: false };
    case 'depository':
      // Savings, CDs and money-market accounts hold cash; so do checking, HSA
      // and prepaid. The distinction here is only for display.
      return {
        type: subtype && ['savings', 'cd', 'money market'].includes(subtype) ? 'savings' : 'checking',
        countsAsCash: true,
      };
    default:
      return { type: 'other', countsAsCash: false };
  }
}

// ─── Transactions ───────────────────────────────────────────────────────────

interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;
  date: string;
  datetime: string | null;
  name: string;
  merchant_name: string | null;
  pending: boolean;
  personal_finance_category?: { primary?: string; detailed?: string } | null;
  payment_channel?: string;
}

interface SyncResponse {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: Array<{ transaction_id: string }>;
  next_cursor: string;
  has_more: boolean;
}

export interface PlaidSyncResult {
  transactions: NormalizedTransaction[];
  removedIds: string[];
  cursor: string;
}

/**
 * Drain the sync cursor. `has_more` means Plaid is still paging, so this loops
 * until caught up and hands back the new cursor to store on the integration.
 *
 * PENDING transactions are skipped. A pending charge changes amount or vanishes
 * before it posts, and alerting the CEO about a dollar that never actually left
 * the account is worse than alerting a day later.
 */
export async function syncTransactions(
  accessToken: string,
  cursor: string | null,
  accountIdFor: (plaidAccountId: string) => string | null,
): Promise<PlaidSyncResult> {
  const transactions: NormalizedTransaction[] = [];
  const removedIds: string[] = [];
  let nextCursor = cursor ?? '';
  let guard = 0;

  for (;;) {
    const page = await plaidPost<SyncResponse>('/transactions/sync', {
      access_token: accessToken,
      cursor: nextCursor || undefined,
      count: 500,
    });

    for (const t of [...page.added, ...page.modified]) {
      if (t.pending) continue;
      const accountId = accountIdFor(t.account_id);
      if (!accountId) continue; // account not linked in our DB yet

      transactions.push(normalize(t, accountId));
    }
    removedIds.push(...page.removed.map((r) => r.transaction_id));

    nextCursor = page.next_cursor;
    if (!page.has_more) break;
    if (++guard > 50) break; // never spin forever on a bad cursor
  }

  return { transactions, removedIds, cursor: nextCursor };
}

function normalize(t: PlaidTransaction, accountId: string): NormalizedTransaction {
  const currency = (t.iso_currency_code ?? t.unofficial_currency_code ?? 'USD').toUpperCase();
  return {
    account_id: accountId,
    txn_date: t.date,
    posted_at: t.datetime,
    amount_minor: toMinor(Math.abs(t.amount), currency),
    currency,
    direction: toDirection(t.amount),
    description: t.name,
    counterparty_name: t.merchant_name ?? t.name,
    source_system: 'plaid',
    external_txn_id: t.transaction_id,
    raw: t as unknown as Record<string, unknown>,
  };
}

/** Plaid: positive = money out, negative = money in. */
export function toDirection(amount: number): TxnDirection {
  return amount > 0 ? 'outflow' : 'inflow';
}
