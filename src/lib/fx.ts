/**
 * Exchange rates for cross-entity rollups (Spec section 3: multi-currency
 * reporting across USD, VND and future currencies).
 *
 * Rates are stored dated, and lookups take the most recent rate at or before
 * the reporting date. A report run today and re-run next month for the same
 * period must produce the same number - which it cannot do if the code reaches
 * for "the current rate" every time.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExchangeRate } from '@/lib/types';
import type { UsdRateMap } from '@/lib/calc/engine';
import type { ISODate } from '@/lib/dates';
import { daysBetween, today } from '@/lib/dates';
import { fetchQuotes, isPlausible } from '@/lib/fx-feed';
import { rowsOrThrow } from '@/lib/supabase/rows';

/**
 * Build the "1 unit of X = N USD" map used by the calc engine.
 *
 * Any currency without a rate is deliberately absent: the engine then values it
 * at zero rather than silently treating 1 VND as 1 USD, and the reconcile page
 * surfaces the gap. Understating is recoverable; a 25,000x overstatement in a
 * runway number is not.
 */
export async function loadUsdRates(
  db: SupabaseClient,
  asOf: ISODate = today(),
): Promise<UsdRateMap> {
  const { data, error } = await db
    .from('exchange_rates')
    .select('base_currency,quote_currency,rate,as_of')
    .eq('quote_currency', 'USD')
    .lte('as_of', asOf)
    .order('as_of', { ascending: false });

  /*
   * An error and an empty table are different claims.
   *
   * No rate on file is a legitimate state: the currency is valued at zero and
   * `/accounts` says which one is unpriced. A failed QUERY is not that — it is
   * the system not working, and returning `{ USD: 1 }` would assert "there are
   * no exchange rates", silently valuing every dong in the ledger at nothing.
   * The two used to be the same branch.
   */
  if (error) {
    throw new Error(`Could not read exchange rates: ${error.message}`);
  }

  const rates: UsdRateMap = { USD: 1 };
  if (!data) return rates;

  for (const row of data as Array<Pick<ExchangeRate, 'base_currency' | 'rate'>>) {
    const key = row.base_currency.toUpperCase();
    // Rows arrive newest-first, so the first one seen per currency wins.
    if (rates[key] === undefined) rates[key] = Number(row.rate);
  }
  return rates;
}

/** Currencies present on accounts/transactions that have no USD rate on file. */
export function missingRates(currencies: string[], rates: UsdRateMap): string[] {
  return [...new Set(currencies.map((c) => c.toUpperCase()))].filter(
    (c) => rates[c] === undefined,
  );
}

/**
 * Which currencies the company actually holds.
 *
 * Fetching the world's 160 currencies to price a ledger that uses two would be
 * noise in the table and a daily reason for the plausibility guard to fire on
 * something nobody reports in. VND is always included: it is the reporting pair
 * the business turns on, and its rate should be on file and current before the
 * first dong is ever imported rather than the morning after.
 */
export async function currenciesInUse(db: SupabaseClient): Promise<string[]> {
  /*
   * The table is `financial_accounts`. This said `accounts` for two days.
   *
   * PostgREST answered 404, `(data ?? [])` made that an empty list, and the
   * function returned `['VND']` every time — so the daily feed has only ever
   * priced the dong. Nothing looked wrong, because VND is the only foreign
   * currency AHN plans to hold. The day a PHP or SGD account was added, its
   * rate would never have been fetched and every balance in it would have been
   * valued at zero, silently.
   *
   * Fourth instance of the same bug in this codebase — see decisions 90, 95, 96
   * — which is why the read now throws instead of shrugging.
   */
  const rows = rowsOrThrow<{ currency: string | null }>(
    await db.from('financial_accounts').select('currency'),
    'account currencies',
  );
  const found = new Set<string>(['VND']);
  for (const row of rows) {
    if (row.currency) found.add(row.currency.toUpperCase());
  }
  found.delete('USD'); // One dollar is one dollar; it is seeded and never fetched.
  return [...found].sort();
}

export interface RateRefreshResult {
  asOf: ISODate;
  written: Array<{ currency: string; rate: number; asOf: ISODate; source: string }>;
  /** Rates a human set for this date. Their number stands. */
  keptManual: string[];
  /** Fetched, disbelieved, and deliberately not written. */
  refused: Array<{ currency: string; rate: number; reason: string }>;
  unchanged: string[];
  problems: string[];
}

/**
 * Pull today's rates and store them, dated.
 *
 * Three rules, each of which exists because breaking it would be worse than
 * having no feed at all:
 *
 *   1. **A rate a person set is never overwritten.** If the CFO typed a rate
 *      for a date - because that is the rate the deal actually closed at, or
 *      because the auditor asked for it - a robot must not quietly replace it
 *      the next morning. The feed writes where no human has.
 *
 *   2. **An implausible rate is refused, not written.** See `isPlausible`. The
 *      table keeps yesterday's number, the dated lookup keeps working, and the
 *      response says loudly what was rejected and why.
 *
 *   3. **Nothing is written in place.** One row per currency per day, exactly as
 *      the manual route does it, so a report re-run for last quarter produces
 *      the number it produced last quarter.
 */
export async function refreshRates(
  db: SupabaseClient,
  opts: { asOf?: ISODate; currencies?: string[] } = {},
): Promise<RateRefreshResult> {
  const asOf = opts.asOf ?? today();
  const wanted = opts.currencies ?? (await currenciesInUse(db));

  const result: RateRefreshResult = {
    asOf,
    written: [],
    keptManual: [],
    refused: [],
    unchanged: [],
    problems: [],
  };
  if (wanted.length === 0) return result;

  const { quotes, problems } = await fetchQuotes(wanted, { fetchedOn: asOf });
  result.problems.push(...problems);

  for (const quote of quotes) {
    // The last thing we knew, whenever that was - not merely yesterday, because
    // the feed may have been down and the gap is what sizes the allowance.
    const { data: prevRow } = await db
      .from('exchange_rates')
      .select('rate,as_of,source')
      .eq('base_currency', quote.currency)
      .eq('quote_currency', 'USD')
      .lte('as_of', quote.asOf)
      .order('as_of', { ascending: false })
      .limit(1)
      .maybeSingle();

    const previous = prevRow
      ? {
          rate: Number((prevRow as { rate: number }).rate),
          asOf: (prevRow as { as_of: string }).as_of,
          source: (prevRow as { source: string }).source,
        }
      : null;

    const verdict = isPlausible(quote.usdPerUnit, previous, quote.asOf);
    if (!verdict.ok) {
      result.refused.push({
        currency: quote.currency,
        rate: quote.usdPerUnit,
        reason: verdict.reason ?? 'implausible',
      });
      continue;
    }

    // Is there already a row for this exact day, and did a person put it there?
    const { data: sameDay } = await db
      .from('exchange_rates')
      .select('rate,source')
      .eq('base_currency', quote.currency)
      .eq('quote_currency', 'USD')
      .eq('as_of', quote.asOf)
      .maybeSingle();

    if (sameDay && (sameDay as { source: string }).source.startsWith('manual:')) {
      result.keptManual.push(quote.currency);
      continue;
    }
    if (sameDay && Number((sameDay as { rate: number }).rate) === quote.usdPerUnit) {
      result.unchanged.push(quote.currency);
      continue;
    }

    const { error } = await db.from('exchange_rates').upsert(
      {
        base_currency: quote.currency,
        quote_currency: 'USD',
        rate: quote.usdPerUnit,
        as_of: quote.asOf,
        source: quote.source,
      },
      { onConflict: 'base_currency,quote_currency,as_of' },
    );

    if (error) {
      result.problems.push(`could not store ${quote.currency}: ${error.message}`);
      continue;
    }
    result.written.push({
      currency: quote.currency,
      rate: quote.usdPerUnit,
      asOf: quote.asOf,
      source: quote.source,
    });
  }

  return result;
}

/** How stale each stored rate is, for the page that has to admit it. */
export interface RateStatus {
  currency: string;
  rate: number;
  asOf: ISODate;
  source: string;
  ageDays: number;
}

export async function loadRateStatus(
  db: SupabaseClient,
  asOf: ISODate = today(),
): Promise<RateStatus[]> {
  const { data } = await db
    .from('exchange_rates')
    .select('base_currency,rate,as_of,source')
    .eq('quote_currency', 'USD')
    .neq('base_currency', 'USD')
    .lte('as_of', asOf)
    .order('as_of', { ascending: false });

  const seen = new Map<string, RateStatus>();
  for (const row of (data ?? []) as Array<{
    base_currency: string;
    rate: number;
    as_of: string;
    source: string;
  }>) {
    const currency = row.base_currency.toUpperCase();
    if (seen.has(currency)) continue;
    seen.set(currency, {
      currency,
      rate: Number(row.rate),
      asOf: row.as_of,
      source: row.source,
      ageDays: daysBetween(row.as_of, asOf),
    });
  }
  return [...seen.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}
