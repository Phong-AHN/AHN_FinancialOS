import type { ISODate } from '@/lib/dates';
import { toMinor } from '@/lib/money';

/**
 * VEEM - Spec section 2 ("especially for Philippines payroll") and section 18.
 *
 * WHAT THE API ACTUALLY IS, established by probing it rather than by reading
 * about it:
 *
 *   - `https://api.veem.com` is the working host. Both `/oauth/token` and
 *     `/veem/v1.2/payments/report` answer 401 JSON there, which is what an
 *     endpoint that exists and wants credentials looks like. Every other path
 *     tried answered 404 with the same JSON shape.
 *   - `https://sandbox-api.veem.com`, which the documentation names as the
 *     sandbox, answers **403 with an HTML sign-in page on every path** —
 *     including `/oauth/token`. It is behind a session wall and does not serve
 *     API traffic. There is therefore no sandbox to prove this against; the
 *     first real call will be against production data.
 *
 * That is why `VEEM_API_BASE` exists and defaults to production: there is no
 * safe default to fall back on, and pretending otherwise would mean shipping a
 * connector pointed at a host that cannot answer.
 */

export const VEEM_PRODUCTION_BASE = 'https://api.veem.com';

export function veemBase(): string {
  return (process.env.VEEM_API_BASE || VEEM_PRODUCTION_BASE).replace(/\/$/, '');
}

export function veemConfigured(): boolean {
  return veemConfigProblems().length === 0;
}

/** Named individually so `/integrations` can say which one is missing. */
export function veemConfigProblems(): string[] {
  const problems: string[] = [];
  if (!process.env.VEEM_CLIENT_ID) problems.push('VEEM_CLIENT_ID is not set.');
  if (!process.env.VEEM_CLIENT_SECRET) problems.push('VEEM_CLIENT_SECRET is not set.');
  return problems;
}

// ─── Auth ───────────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/**
 * Client-credentials token.
 *
 * Basic auth over the client id and secret, form-encoded body, `scope=all` —
 * the only scope the documentation defines. Veem's tokens last about a year
 * (`expires_in: 31535999`), which is long enough that caching one in memory
 * across a serverless invocation buys nothing; each sync asks for its own.
 */
export async function fetchAccessToken(opts: { timeoutMs?: number } = {}): Promise<string> {
  const problems = veemConfigProblems();
  if (problems.length > 0) throw new Error(problems.join(' '));

  const credentials = Buffer.from(
    `${process.env.VEEM_CLIENT_ID}:${process.env.VEEM_CLIENT_SECRET}`,
  ).toString('base64');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);

  try {
    const res = await fetch(`${veemBase()}/oauth/token`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Basic ${credentials}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'all' }).toString(),
      cache: 'no-store',
    });

    const text = await res.text();
    let body: TokenResponse = {};
    try {
      body = JSON.parse(text) as TokenResponse;
    } catch {
      // A sign-in page rather than JSON is the symptom of pointing at
      // sandbox-api.veem.com, so say that instead of "unexpected token <".
      throw new Error(
        `VEEM returned ${res.status} and HTML rather than JSON. ` +
          `Check VEEM_API_BASE — the sandbox host serves a sign-in page, not the API.`,
      );
    }

    if (!res.ok || !body.access_token) {
      throw new Error(
        `VEEM token request failed (${res.status}): ${body.error_description ?? body.error ?? text.slice(0, 200)}`,
      );
    }
    return body.access_token;
  } finally {
    clearTimeout(timer);
  }
}

// ─── The payment report ─────────────────────────────────────────────────────

/**
 * Veem's own status vocabulary.
 *
 * Only `Complete` has actually moved money. The rest are a payment on its way,
 * which is a commitment rather than cash — the same line spec section 18 draws
 * and the same one decision 85 drew for QuickBooks invoices.
 */
export type VeemStatus =
  | 'Drafted'
  | 'Sent'
  | 'PendingAuth'
  | 'Authorized'
  | 'InProgress'
  | 'Complete'
  | 'Cancelled'
  | 'Closed';

export const SETTLED_STATUS: VeemStatus = 'Complete';
/** Neither cash nor a commitment: these are never going to happen. */
export const DEAD_STATUSES: readonly VeemStatus[] = ['Cancelled', 'Closed'];

export interface VeemAmount {
  number?: number | string;
  currency?: string;
}

export interface VeemPayment {
  id?: number | string;
  status?: VeemStatus | string;
  timeCreated?: string;
  payee?: {
    countryCode?: string;
    email?: string;
    name?: string;
    firstName?: string;
    lastName?: string;
    businessName?: string;
    payeeAmount?: VeemAmount;
  };
  payer?: {
    countryCode?: string;
    email?: string;
    name?: string;
    firstName?: string;
    lastName?: string;
    businessName?: string;
    payerAccountId?: number | string;
    fundingMethodType?: string;
    payerAmount?: VeemAmount;
  };
  /** Free text the sender attached; useful as a description. */
  note?: string;
  purposeOfPayment?: string;
}

export interface VeemReportPage {
  content?: VeemPayment[];
  totalPages?: number;
  totalElements?: number;
  number?: number;
  last?: boolean;
}

/** ISO 8601, which is what `startDate` and `endDate` want. */
export function toReportDate(day: ISODate): string {
  return `${day}T00:00:00Z`;
}

export interface ReportQuery {
  accessToken: string;
  from: ISODate;
  to: ISODate;
  pageSize?: number;
  timeoutMs?: number;
}

/**
 * One page of the payment report.
 *
 * Veem caps a query at one year; the caller is responsible for not asking for
 * more, and `fetchAllPayments` below splits a longer range rather than letting
 * the API refuse it.
 */
export async function fetchReportPage(
  query: ReportQuery & { pageNumber: number },
): Promise<VeemReportPage> {
  const params = new URLSearchParams({
    startDate: toReportDate(query.from),
    endDate: toReportDate(query.to),
    pageNumber: String(query.pageNumber),
    pageSize: String(query.pageSize ?? 100),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), query.timeoutMs ?? 20_000);

  try {
    const res = await fetch(`${veemBase()}/veem/v1.2/payments/report?${params}`, {
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${query.accessToken}`,
        accept: 'application/json',
      },
      cache: 'no-store',
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`VEEM report failed (${res.status}): ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text) as VeemReportPage;
    } catch {
      throw new Error('VEEM returned a non-JSON report body. Check VEEM_API_BASE.');
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Every page in the range, following `last` rather than guessing a count. */
export async function fetchAllPayments(query: ReportQuery): Promise<VeemPayment[]> {
  const out: VeemPayment[] = [];
  for (let page = 0; page < 200; page++) {
    const body = await fetchReportPage({ ...query, pageNumber: page });
    out.push(...(body.content ?? []));
    if (body.last !== false) break;
    if ((body.content ?? []).length === 0) break;
  }
  return out;
}

// ─── Normalising ────────────────────────────────────────────────────────────

export function amountToMinor(amount: VeemAmount | undefined): {
  minor: number;
  currency: string;
} | null {
  if (!amount) return null;
  const currency = (amount.currency ?? 'USD').toUpperCase();
  // Prefer the string form when the API sends one: a float that has already
  // been through JSON is a float, and 1450.005 is not recoverable afterwards.
  const raw = typeof amount.number === 'string' ? Number(amount.number) : amount.number;
  if (raw === undefined || raw === null || !Number.isFinite(raw)) return null;
  return { minor: toMinor(Math.abs(raw), currency), currency };
}

/**
 * Who the money went to, from whichever field Veem populated.
 *
 * The report's documented shape carries a country code and no name, but live
 * payloads have carried business names and emails. Rather than assume one, the
 * likeliest fields are tried in order and the payment id is the last resort —
 * labelled as such, so a row that says "VEEM payment 8841203" is visibly a
 * missing name rather than somebody actually called that.
 */
export function counterpartyName(payment: VeemPayment, direction: 'inflow' | 'outflow'): string {
  const side = direction === 'outflow' ? payment.payee : payment.payer;
  const parts = [side?.firstName, side?.lastName].filter(Boolean).join(' ').trim();
  return (
    side?.businessName?.trim() ||
    side?.name?.trim() ||
    (parts !== '' ? parts : '') ||
    side?.email?.trim() ||
    `VEEM payment ${payment.id ?? 'unknown'}`
  );
}

export interface NormalizedVeemPayment {
  externalId: string;
  direction: 'inflow' | 'outflow';
  /** True once the money has actually moved. False means it is a commitment. */
  settled: boolean;
  dead: boolean;
  status: string;
  date: ISODate | null;
  amountMinor: number;
  currency: string;
  counterpartyName: string;
  description: string | null;
  countryCode: string | null;
}

export interface NormalizeOptions {
  /**
   * AHN's own Veem account id, used to tell a payment out from a payment in.
   *
   * Optional, and when it is absent every row is treated as an OUTFLOW. That is
   * a stated assumption, not a guess dressed up as a fact: AHN's documented use
   * is sending Philippines payroll, and the report is scoped to AHN's own
   * account. Set `VEEM_ACCOUNT_ID` once a real payload shows what the field
   * holds, and money received will be recognised as received.
   */
  ownAccountId?: string | null;
}

export function normalizePayment(
  payment: VeemPayment,
  opts: NormalizeOptions = {},
): NormalizedVeemPayment | null {
  const status = String(payment.status ?? '');
  const own = opts.ownAccountId?.trim();
  const payerId = payment.payer?.payerAccountId;

  const direction: 'inflow' | 'outflow' =
    own && payerId !== undefined && String(payerId) !== own ? 'inflow' : 'outflow';

  // The money that left or arrived at AHN's side, not the counterparty's. A
  // Philippines payee receiving PHP is not what came out of AHN's USD balance.
  const amount =
    direction === 'outflow'
      ? amountToMinor(payment.payer?.payerAmount) ?? amountToMinor(payment.payee?.payeeAmount)
      : amountToMinor(payment.payee?.payeeAmount) ?? amountToMinor(payment.payer?.payerAmount);

  if (!amount || amount.minor <= 0) return null;
  if (payment.id === undefined || payment.id === null) return null;

  const day = (payment.timeCreated ?? '').slice(0, 10);

  return {
    externalId: `veem:${payment.id}`,
    direction,
    settled: status === SETTLED_STATUS,
    dead: (DEAD_STATUSES as readonly string[]).includes(status),
    status,
    date: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null,
    amountMinor: amount.minor,
    currency: amount.currency,
    counterpartyName: counterpartyName(payment, direction),
    description:
      payment.note?.trim() ||
      payment.purposeOfPayment?.trim() ||
      null,
    countryCode:
      (direction === 'outflow' ? payment.payee?.countryCode : payment.payer?.countryCode) ?? null,
  };
}

export interface SplitPayments {
  /** Money that has moved. Belongs in the ledger. */
  settled: NormalizedVeemPayment[];
  /** Money on its way. Belongs in `obligations`, per spec section 18. */
  inFlight: NormalizedVeemPayment[];
  /** Cancelled or closed: neither cash nor a commitment. */
  discarded: NormalizedVeemPayment[];
}

/**
 * The split that makes this connector correct.
 *
 * A payment Veem has accepted but not yet delivered is not cash — counting it
 * as cash overstates what left the bank and understates the balance. It is also
 * not nothing: it is exactly the "known commitment before money leaves the
 * bank" section 18 asks to be tracked. So it goes to `obligations`, the same
 * place a QuickBooks bill goes, and moves to the ledger when Veem says
 * Complete.
 */
export function splitByStatus(payments: NormalizedVeemPayment[]): SplitPayments {
  const settled: NormalizedVeemPayment[] = [];
  const inFlight: NormalizedVeemPayment[] = [];
  const discarded: NormalizedVeemPayment[] = [];

  for (const p of payments) {
    if (p.dead) discarded.push(p);
    else if (p.settled) settled.push(p);
    else inFlight.push(p);
  }
  return { settled, inFlight, discarded };
}
