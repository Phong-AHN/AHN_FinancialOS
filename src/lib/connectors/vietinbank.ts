/**
 * VietinBank iConnect, ERP Statement API - Spec section 2.
 *
 * Written against the bank's own OpenAPI document, kept at
 * `docs/api-specs/vietinbank-statement-1.0.0.json`. Every path, field name and
 * format below traces to a line in it.
 *
 * WHY THIS RATHER THAN THE AGGREGATOR: Finverse lists both VietinBank and
 * Techcombank as INDIVIDUAL accounts only. AHN banks as a company. This API is
 * the ERP corporate channel, which is the one that reaches the money.
 *
 * FOUR THINGS THE SPEC SETTLED THAT WOULD HAVE BEEN WRONG BY GUESS:
 *
 *   1. It is NOT OAuth2. Authentication is two apiKey headers,
 *      `X-IBM-Client-Id` and `X-IBM-Client-Secret` - the IBM API Connect
 *      gateway convention. An earlier draft of this file implemented an OAuth2
 *      client-credentials exchange against `/oauth2/token`, which does not
 *      exist here.
 *   2. `debit` and `credit` are SEPARATE string fields, one of them empty -
 *      not one signed amount.
 *   3. Dates differ between request and response: `DD/MM/YYYY` going out,
 *      `DD-MM-YYYY HH:mm:ss` coming back. Slash one way, hyphen the other.
 *   4. `status.code` is `"1"` for success, not `"0"`.
 */

import type { NormalizedTransaction, TxnDirection } from '@/lib/types';
import { parseAmount, toMinor } from '@/lib/money';
import type { ISODate } from '@/lib/dates';

export type VietinBankEnvironment = 'sandbox' | 'production';

/**
 * Host and base path exactly as the specification declares them.
 *
 * The spec's `x-ibm-configuration.servers` lists the sandbox URL for BOTH
 * "production" and "development", which cannot both be right - so production is
 * overridable and defaults to nothing rather than to a guess. Pointing a live
 * deployment at whatever seemed likely is not a mistake worth risking.
 */
const SPEC_HOST = 'sandbox.vietinbank.vn';
const SPEC_BASE_PATH = '/vtb/openbanking/erp/v1/statement';

export function vietinbankEnvironment(): VietinBankEnvironment {
  return process.env.VIETINBANK_ENV === 'production' ? 'production' : 'sandbox';
}

export function vietinbankBase(): string {
  const override = process.env.VIETINBANK_API_BASE?.trim();
  if (override) return override.replace(/\/+$/, '');
  return `https://${SPEC_HOST}${SPEC_BASE_PATH}`;
}

export function vietinbankConfigured(): boolean {
  return Boolean(process.env.VIETINBANK_CLIENT_ID && process.env.VIETINBANK_CLIENT_SECRET);
}

/**
 * Everything wrong with the configuration, as sentences rather than a boolean.
 *
 * The partner identifiers are checked as carefully as the keys: `providerId`
 * and `merchantId` are values VietinBank assigns, and a request carrying the
 * wrong one is answered with a status code rather than an HTTP error - so it
 * fails silently unless something looks.
 */
export function vietinbankConfigProblems(): string[] {
  const problems: string[] = [];

  if (!process.env.VIETINBANK_CLIENT_ID) {
    problems.push(
      'VIETINBANK_CLIENT_ID is not set. It is the X-IBM-Client-Id header, issued when the application is created at openapi.vietinbank.vn.',
    );
  } else if (isDocPlaceholder(process.env.VIETINBANK_CLIENT_ID)) {
    problems.push(
      `VIETINBANK_CLIENT_ID is "${DOC_PLACEHOLDER}" — the wording from the specification's parameter description, not a key. The gateway answers this with 401 "Invalid client id or secret".`,
    );
  }

  if (!process.env.VIETINBANK_CLIENT_SECRET) {
    problems.push('VIETINBANK_CLIENT_SECRET is not set. It is the X-IBM-Client-Secret header, shown once at creation.');
  } else if (isDocPlaceholder(process.env.VIETINBANK_CLIENT_SECRET)) {
    problems.push(
      `VIETINBANK_CLIENT_SECRET is "${DOC_PLACEHOLDER}", which is the description text rather than the secret.`,
    );
  }
  if (!process.env.VIETINBANK_ACCOUNT_NUMBER) {
    problems.push(
      'VIETINBANK_ACCOUNT_NUMBER is not set. The statement API answers for one account per call, so it has to be told which.',
    );
  }
  if (!process.env.VIETINBANK_PROVIDER_ID) {
    problems.push('VIETINBANK_PROVIDER_ID is not set. VietinBank assigns it (Mã nhà cung cấp dịch vụ).');
  }
  if (!process.env.VIETINBANK_MERCHANT_ID) {
    problems.push('VIETINBANK_MERCHANT_ID is not set. VietinBank assigns it (Mã merchant).');
  }

  const env = process.env.VIETINBANK_ENV;
  if (env && env !== 'sandbox' && env !== 'production') {
    problems.push(`VIETINBANK_ENV must be "sandbox" or "production", not "${env}".`);
  }
  if (env === 'production' && !process.env.VIETINBANK_API_BASE?.trim()) {
    problems.push(
      'VIETINBANK_ENV is "production" but VIETINBANK_API_BASE is not set. The specification lists only the sandbox host, so there is no production address to fall back to.',
    );
  }

  return problems;
}

/**
 * The Swagger document describes both credential headers as
 * "apiKey located in header". Pasted into an env file it is a plausible
 * 24-character string that looks like a key and is not one - and the gateway
 * answers it with the same 401 as a genuinely wrong secret, so nothing on
 * screen would distinguish "I copied the wrong line" from "my key expired".
 */
const DOC_PLACEHOLDER = 'apiKey located in header';

function isDocPlaceholder(value: string): boolean {
  return value.trim().toLowerCase() === DOC_PLACEHOLDER.toLowerCase();
}

// ─── Request ────────────────────────────────────────────────────────────────

export interface StatementQuery {
  account?: string;
  from: ISODate;
  to: ISODate;
}

/**
 * `DD/MM/YYYY`, the format the REQUEST uses.
 *
 * Not interchangeable with the response format, which is `DD-MM-YYYY`. Sending
 * a hyphen here, or parsing a slash there, is the kind of mistake a bank
 * answers by returning an empty statement rather than an error.
 */
export function toRequestDate(iso: ISODate): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** `YYYYMMDDHHmmss`, the `transTime` format. */
export function toTransTime(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

export function buildStatementRequest(
  query: StatementQuery,
  now: Date = new Date(),
): Record<string, string> {
  const account = query.account ?? process.env.VIETINBANK_ACCOUNT_NUMBER ?? '';

  return {
    model: process.env.VIETINBANK_MODEL ?? '1',
    // Unique per call. The bank treats it as the partner's own reference, and
    // reusing one across calls is how a retry gets mistaken for a duplicate.
    requestId: `AHN${toTransTime(now)}${Math.floor(Math.random() * 1000)
      .toString()
      .padStart(3, '0')}`,
    providerId: process.env.VIETINBANK_PROVIDER_ID ?? '',
    merchantId: process.env.VIETINBANK_MERCHANT_ID ?? '',
    account,
    fromDate: toRequestDate(query.from),
    toDate: toRequestDate(query.to),
    fromTime: '00:00:00',
    toTime: '23:59:59',
    accountType: process.env.VIETINBANK_ACCOUNT_TYPE ?? 'D',

    // `collectionType` is DELIBERATELY ABSENT.
    //
    // The specification describes it as "Loại truy vấn (d ghi nợ, c ghi có)" -
    // a filter for debits OR credits. Its example value is "d". Copying the
    // example would return only money going out, and the ledger would be
    // missing every payment received while looking perfectly complete.

    transTime: toTransTime(now),
    channel: process.env.VIETINBANK_CHANNEL ?? 'ERP',
    version: '1',
    language: 'vi',
  };
}

// ─── Response ───────────────────────────────────────────────────────────────

export interface VietinBankTransaction {
  order?: string;
  transactionDate?: string;
  transactionContent?: string;
  mtId?: string | null;
  /** Money out, as a string. Empty or null when this row is a credit. */
  debit?: string | null;
  /** Money in, as a string. Empty or null when this row is a debit. */
  credit?: string | null;
  accountBal?: string;
  transactionNumber?: string;
  corresponsiveAccount?: string | null;
  corresponsiveAccountName?: string | null;
  virtualAccount?: string | null;
  corresponsiveBankName?: string | null;
  corresponsiveBankId?: string | null;
  serviceBranchId?: string | null;
  serviceBankName?: string | null;
  channel?: string | null;
  agency?: {
    account?: string | null;
    branchCode?: string | null;
    name?: string | null;
    productType?: string | null;
    productName?: string | null;
  };
}

export interface StatementResponse {
  requestId?: string;
  status?: { code?: string; message?: string };
  account?: string;
  companyName?: string;
  accountType?: string;
  /** Misspelled in the bank's specification. Matched exactly on purpose. */
  curency?: string;
  accountBal?: string;
  availableBal?: string;
  /** Also misspelled in the specification. */
  openningBal?: string;
  closingBal?: string;
  totalCredit?: string;
  totalDebit?: string;
  numberCreditTransaction?: string;
  numberDebitTransaction?: string;
  transactions?: VietinBankTransaction[];
}

/**
 * `"1"` means success.
 *
 * Worth its own function because every other system in this codebase treats 0
 * as success, and a `!code` check would read failure as success on a response
 * that had no status at all.
 */
export function isSuccess(response: StatementResponse): boolean {
  return response.status?.code === SUCCESS_CODE;
}

const SUCCESS_CODE = '1';

/**
 * `DD-MM-YYYY HH:mm:ss` -> an ISO date.
 *
 * Hyphens here, slashes in the request. Returns null rather than a guess when
 * the shape is unfamiliar: a transaction booked on the wrong day lands in the
 * wrong month, and a month-end figure is exactly what somebody reports.
 */
export function parseTransactionDate(raw: string | null | undefined): ISODate | null {
  if (!raw) return null;
  const match = raw.trim().match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (!match) return null;
  const [, d, m, y] = match;
  return `${y}-${m}-${d}`;
}

/** The timestamp half, when there is one. */
export function parseTransactionTime(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.trim().match(/^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}:\d{2}:\d{2})/);
  if (!match) return null;
  const [, d, m, y, time] = match;
  return `${y}-${m}-${d}T${time}Z`;
}

export interface ParsedAmount {
  minor: number;
  direction: TxnDirection;
}

/**
 * The debit/credit pair -> one amount and a direction.
 *
 * Both fields arrive as strings and exactly one carries a value. Amounts come
 * through with decimals the currency does not have - "7192010.00" for a dong
 * figure - so the currency drives the scaling rather than a fixed x100.
 *
 * A row with both filled, or neither, returns null. That is not a defensive
 * flourish: booking half of an unreadable row would put a real amount in the
 * ledger pointing the wrong way.
 */
export function parseDebitCredit(
  txn: Pick<VietinBankTransaction, 'debit' | 'credit'>,
  currency: string,
): ParsedAmount | null {
  const debit = numeric(txn.debit, currency);
  const credit = numeric(txn.credit, currency);

  if (debit !== null && credit !== null) return null;
  if (debit !== null) return { minor: Math.abs(debit), direction: 'outflow' };
  if (credit !== null) return { minor: Math.abs(credit), direction: 'inflow' };
  return null;
}

function numeric(raw: string | null | undefined, currency: string): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const parsed = parseAmount(trimmed, { currency });
  if (parsed === null) return null;
  // A zero is a real value in a field that is normally blank, but it is not a
  // transaction; treating it as one would create phantom rows on every
  // statement that pads both columns.
  if (parsed === 0) return null;
  return toMinor(parsed, currency);
}

// ─── Normalisation ──────────────────────────────────────────────────────────

export interface NormalizeOptions {
  /** Our `financial_accounts.id` for the account this statement belongs to. */
  accountId: string;
  /** Falls back to the statement's own currency, then VND. */
  currency?: string;
}

export interface NormalizeResult {
  rows: NormalizedTransaction[];
  skippedNoDate: number;
  skippedNoAmount: number;
}

/**
 * A statement response -> ledger rows.
 *
 * Two reasons a row is dropped rather than guessed at, each counted so a sync
 * can report what it did not take:
 *
 *   - NO READABLE DATE. A transaction on the wrong day lands in the wrong
 *     month, and a month-end figure is what gets reported to a bank or a board.
 *   - NO READABLE AMOUNT, or both columns filled. Not a zero-value
 *     transaction - a row we failed to read.
 */
export function normalizeStatement(
  response: StatementResponse,
  options: NormalizeOptions,
): NormalizeResult {
  const currency = (options.currency ?? response.curency ?? 'VND').toUpperCase();
  const account = response.account ?? process.env.VIETINBANK_ACCOUNT_NUMBER ?? '';

  const result: NormalizeResult = { rows: [], skippedNoDate: 0, skippedNoAmount: 0 };

  for (const txn of response.transactions ?? []) {
    const txnDate = parseTransactionDate(txn.transactionDate);
    if (!txnDate) {
      result.skippedNoDate++;
      continue;
    }

    const amount = parseDebitCredit(txn, currency);
    if (!amount) {
      result.skippedNoAmount++;
      continue;
    }

    // `transactionNumber` is the bank's own reference. Scoped by account
    // because the same reference could recur on a different account, and the
    // unique index is on (source_system, external_txn_id) alone.
    const reference = txn.transactionNumber?.trim();
    const externalId = reference
      ? `${account}:${reference}`
      : // No reference at all: fall back to something reproducible, so
        // re-syncing the same statement does not insert the rows twice.
        `${account}:${txnDate}:${amount.direction}:${amount.minor}:${(txn.order ?? '').trim()}`;

    result.rows.push({
      account_id: options.accountId,
      txn_date: txnDate,
      posted_at: parseTransactionTime(txn.transactionDate),
      amount_minor: amount.minor,
      currency,
      direction: amount.direction,
      description: txn.transactionContent?.trim() || null,
      // The other side of the transaction, which is exactly what a counterparty
      // is - far better than parsing it back out of the description.
      counterparty_name: txn.corresponsiveAccountName?.trim() || null,
      source_system: 'vietinbank',
      external_txn_id: externalId,
      raw: txn as unknown as Record<string, unknown>,
    });
  }

  return result;
}

// ─── The call ───────────────────────────────────────────────────────────────

/**
 * `POST /inquiry` - one account, one date range.
 *
 * The gateway answers 200 with a status code inside the body, so an HTTP check
 * alone is not enough: a rejected request looks like a successful one to
 * anything that only reads `res.ok`.
 */
export async function fetchStatement(query: StatementQuery): Promise<StatementResponse> {
  if (!vietinbankConfigured()) {
    throw new Error('VietinBank credentials are not set.');
  }

  const body = buildStatementRequest(query);

  const res = await fetch(`${vietinbankBase()}/inquiry`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'X-IBM-Client-Id': process.env.VIETINBANK_CLIENT_ID!,
      'X-IBM-Client-Secret': process.env.VIETINBANK_CLIENT_SECRET!,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    // The API Connect gateway rejects before the bank ever sees the request,
    // and its error shape is different from the in-body `status` a business
    // rejection uses: {httpCode, httpMessage, moreInformation}. Reading it
    // turns "401 {json blob}" into the sentence the gateway actually wrote.
    throw new Error(`VietinBank statement failed: ${describeGatewayError(res.status, text)}`);
  }

  let json: StatementResponse;
  try {
    json = JSON.parse(text) as StatementResponse;
  } catch {
    throw new Error(`VietinBank returned a non-JSON body: ${text.slice(0, 200)}`);
  }

  if (!isSuccess(json)) {
    throw new Error(
      `VietinBank refused the request: status ${json.status?.code ?? '(none)'} — ${
        json.status?.message ?? 'no message'
      }. Check VIETINBANK_PROVIDER_ID, VIETINBANK_MERCHANT_ID and the account number; a wrong one is answered here rather than with an HTTP error.`,
    );
  }

  return json;
}

/**
 * The signature field, which this connector does not populate.
 *
 * `signature` ("Chữ ký số") is in the request schema, but the specification
 * declares no required fields at all and documents neither the algorithm nor
 * what gets signed. It is left out rather than filled with something invented:
 * a wrong signature is refused the same way a missing one is, and the refusal
 * message names it either way.
 *
 * If the sandbox rejects unsigned requests, the portal's signing documentation
 * is the missing piece — and it needs a key pair, not another secret.
 */
function describeGatewayError(status: number, body: string): string {
  let detail = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { httpMessage?: string; moreInformation?: string };
    if (parsed.moreInformation || parsed.httpMessage) {
      detail = [parsed.httpMessage, parsed.moreInformation].filter(Boolean).join(' — ');
    }
  } catch {
    /* not JSON; the raw body is the best available answer */
  }

  if (status === 401) {
    return `${status} ${detail}. The gateway checks X-IBM-Client-Id and X-IBM-Client-Secret before the bank sees anything, so this is the keys — not the account number or the partner identifiers.`;
  }
  if (status === 404) {
    return `${status} ${detail}. A 404 here is the path or the host, not the credentials; check VIETINBANK_API_BASE.`;
  }
  return `${status} ${detail}`;
}

export const SIGNATURE_NOT_IMPLEMENTED =
  'Requests are sent unsigned. The specification includes a `signature` field but documents neither the algorithm nor the payload to sign. If VietinBank refuses unsigned requests, that documentation and an RSA key pair are what is needed.';
