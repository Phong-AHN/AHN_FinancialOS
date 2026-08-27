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
import { today } from '@/lib/dates';

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

  const rates: UsdRateMap = { USD: 1 };
  if (error || !data) return rates;

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
