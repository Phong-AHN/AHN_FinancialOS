/**
 * Stripe connector - MVP Plan Day 3.
 *
 * Reads /v1/balance_transactions rather than /v1/charges, because that endpoint
 * is the one that mirrors the Stripe balance: it includes charges, refunds,
 * processing fees, disputes and payouts, all already denominated in the minor
 * unit Stripe settles in. Syncing only charges would show gross revenue and
 * quietly hide the fees, overstating what actually reached the bank.
 *
 * Payouts are recorded as internal transfers: money moving from the Stripe
 * balance to AHN bank account is not an expense, and the bank side of the same
 * movement already arrives through Plaid.
 */

import type { NormalizedTransaction } from '@/lib/types';
import type { ISODate } from '@/lib/dates';
import { parseISODate } from '@/lib/dates';

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * Which Stripe account the key actually reaches.
 *
 * A test key returns a plausible-looking balance and a full transaction history
 * that is entirely fabricated. Nothing about the resulting dashboard would look
 * wrong - which is exactly why the mode has to be visible rather than inferred.
 */
export function stripeMode(): 'live' | 'test' | 'restricted' | 'unknown' | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (key.startsWith('sk_live_')) return 'live';
  if (key.startsWith('sk_test_')) return 'test';
  if (key.startsWith('rk_')) return 'restricted';
  return 'unknown';
}

export function stripeConfigProblems(): string[] {
  const problems: string[] = [];
  const mode = stripeMode();
  if (!mode) {
    problems.push('STRIPE_SECRET_KEY is not set.');
  } else if (mode === 'unknown') {
    problems.push(
      'STRIPE_SECRET_KEY does not look like a Stripe secret key (expected sk_live_…, sk_test_… or rk_…).',
    );
  }
  return problems;
}

interface StripeBalanceTransaction {
  id: string;
  amount: number; // minor units, signed: positive = into the balance
  net: number;
  fee: number;
  currency: string;
  created: number; // unix seconds
  type: string;
  description: string | null;
  source: string | null;
}

interface StripeList<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
}

async function stripeGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `https://api.stripe.com${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Stripe-Version': '2024-06-20',
    },
  });
  if (!res.ok) {
    throw new Error(`Stripe ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** A payout moves our own money to our own bank - not revenue, not expense. */
const TRANSFER_TYPES = new Set(['payout', 'payout_cancel', 'payout_failure', 'transfer']);

export async function fetchStripeTransactions(
  accountId: string,
  since: ISODate,
): Promise<NormalizedTransaction[]> {
  const createdGte = Math.floor(parseISODate(since).getTime() / 1000);
  const out: NormalizedTransaction[] = [];
  let startingAfter: string | undefined;
  let guard = 0;

  for (;;) {
    const params: Record<string, string> = {
      limit: '100',
      'created[gte]': String(createdGte),
    };
    if (startingAfter) params.starting_after = startingAfter;

    const page = await stripeGet<StripeList<StripeBalanceTransaction>>(
      '/v1/balance_transactions',
      params,
    );

    for (const t of page.data) {
      const currency = t.currency.toUpperCase();
      const isTransfer = TRANSFER_TYPES.has(t.type);

      out.push({
        account_id: accountId,
        txn_date: new Date(t.created * 1000).toISOString().slice(0, 10),
        posted_at: new Date(t.created * 1000).toISOString(),
        // Stripe already reports minor units; only the sign needs interpreting.
        amount_minor: Math.abs(t.amount),
        currency,
        direction: t.amount >= 0 ? 'inflow' : 'outflow',
        description: t.description ?? `Stripe ${t.type}`,
        counterparty_name: isTransfer ? 'Stripe payout' : (t.description ?? 'Stripe'),
        category: isTransfer ? 'transfer' : undefined,
        is_internal_transfer: isTransfer,
        source_system: 'stripe',
        external_txn_id: t.id,
        raw: t as unknown as Record<string, unknown>,
      });

      // Processing fees are a real expense and are netted inside `amount`, so
      // they are booked as their own line to keep the cost visible (spec 7).
      if (t.fee > 0 && !isTransfer) {
        out.push({
          account_id: accountId,
          txn_date: new Date(t.created * 1000).toISOString().slice(0, 10),
          amount_minor: t.fee,
          currency,
          direction: 'outflow',
          description: `Stripe processing fee for ${t.id}`,
          counterparty_name: 'Stripe',
          category: 'bank_fees',
          subcategory: 'processing',
          source_system: 'stripe',
          external_txn_id: `${t.id}:fee`,
        });
      }
    }

    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1]!.id;
    if (++guard > 100) break;
  }

  return out;
}

/** Current Stripe balance, minor units, keyed by currency. */
export async function fetchStripeBalance(): Promise<Record<string, number>> {
  const balance = await stripeGet<{
    available: Array<{ amount: number; currency: string }>;
    pending: Array<{ amount: number; currency: string }>;
  }>('/v1/balance', {});

  const totals: Record<string, number> = {};
  for (const entry of [...balance.available, ...balance.pending]) {
    const key = entry.currency.toUpperCase();
    totals[key] = (totals[key] ?? 0) + entry.amount;
  }
  return totals;
}
