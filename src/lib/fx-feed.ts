/**
 * Automatic exchange rates - Spec section 3, plan section 8 Phase 3
 * ("complete multi-currency reporting, automatic VND/USD conversion").
 *
 * Until now the only way a rate reached the table was somebody typing it. That
 * was survivable while every account was USD. It stops being survivable the day
 * a VND account exists: the seeded rate of 0.0000380 was already 1.2% away from
 * the market by the time this was written, and nothing in the system would ever
 * have said so.
 *
 * Two sources, deliberately in this order:
 *
 *   1. Vietcombank, which publishes the rate AHN can actually transact at. A
 *      Vietnamese company's books are expected to use a commercial bank's rate
 *      (Circular 200), not a mid-market index nobody will trade with them at.
 *      It also prices every currency it lists in VND, so one fetch prices the
 *      whole ledger.
 *   2. exchangerate-api, mid-market and global, used only for currencies
 *      Vietcombank does not list, and when Vietcombank cannot be reached.
 *
 * Neither needs an API key, which is the difference between a feed that runs on
 * day one and a feed that waits on somebody's signup.
 */

import type { ISODate } from '@/lib/dates';
import { parseISODate, toISODate, today } from '@/lib/dates';

/** Vietcombank asks for no more than one request every five minutes. */
export const VIETCOMBANK_URL =
  'https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx?b=10';
export const FALLBACK_URL = 'https://open.er-api.com/v6/latest/USD';

/**
 * The scale of `exchange_rates.rate`, which is `numeric(20,10)`.
 *
 * Rates are rounded to it BEFORE they are compared or stored, so that what the
 * code holds and what the database holds are the same number. Without this,
 * 1/26260 is computed as 0.00003808073115 and stored as 0.0000380807, the two
 * never compare equal, and the "unchanged" branch can never be reached - the
 * feed rewrites the same row on every single run and reports it as new. That
 * was the live behaviour: "second run: 1 written, 0 unchanged".
 *
 * Ten decimal places leaves the dong six significant figures, which is a
 * rounding error of under one part per million - eight cents on a hundred
 * thousand dollars.
 */
export const RATE_DECIMALS = 10;

export function quantiseRate(rate: number): number {
  return Number(rate.toFixed(RATE_DECIMALS));
}

/** A rate ready to store: how many USD one unit of `currency` is worth. */
export interface FeedQuote {
  currency: string;
  usdPerUnit: number;
  asOf: ISODate;
  source: string;
}

/** What a bank quotes for one unit of a foreign currency, in VND. */
export interface BankQuote {
  currency: string;
  buy: number | null;
  transfer: number | null;
  sell: number | null;
}

/**
 * The widest a rate may move before we refuse to believe it.
 *
 * The failure this guards against is not a rate wrong by a percent. It is a
 * rate wrong by 26,000x because a provider quoted dong-per-dollar where we
 * expected dollar-per-dong, or wrong by 95% because a parser picked up the
 * neighbouring currency's row. Every cash, runway and break-even figure in the
 * company is downstream of this number, so a suspicious one is refused and
 * reported rather than written and reasoned about later.
 *
 * The allowance grows with the gap since the last rate, because a feed that has
 * been down for a month should not reject a month of genuine drift.
 */
export const MAX_DRIFT_PER_DAY = 0.02;
export const MIN_DRIFT_ALLOWANCE = 0.05;
export const MAX_DRIFT_ALLOWANCE = 0.25;

export function driftAllowance(daysApart: number): number {
  const scaled = MAX_DRIFT_PER_DAY * Math.max(1, daysApart);
  return Math.min(MAX_DRIFT_ALLOWANCE, Math.max(MIN_DRIFT_ALLOWANCE, scaled));
}

export interface PlausibilityResult {
  ok: boolean;
  reason?: string;
  drift?: number;
}

/**
 * Is this rate believable, given what we last knew?
 *
 * With no previous rate on file only the absolute band applies - it is the
 * inverted-units mistake that has to be caught, and 1 VND being worth 26,000
 * USD fails that band by nine orders of magnitude.
 */
export function isPlausible(
  next: number,
  previous: { rate: number; asOf: ISODate } | null,
  asOf: ISODate,
): PlausibilityResult {
  if (!Number.isFinite(next) || next <= 0) {
    return { ok: false, reason: 'not a positive number' };
  }
  // The same band the manual route enforces: a rate is USD per unit, so
  // anything at or above 1,000 is somebody quoting the pair upside down.
  if (next >= 1_000) {
    return { ok: false, reason: `${next} USD per unit is the pair inverted` };
  }
  if (!previous) return { ok: true };

  const drift = Math.abs(next - previous.rate) / previous.rate;
  const days = Math.abs(
    Math.round(
      (parseISODate(asOf).getTime() - parseISODate(previous.asOf).getTime()) / 86_400_000,
    ),
  );
  const allowance = driftAllowance(days);
  if (drift > allowance) {
    return {
      ok: false,
      drift,
      reason:
        `moved ${(drift * 100).toFixed(1)}% from ${previous.rate} on ${previous.asOf}, ` +
        `more than the ${(allowance * 100).toFixed(0)}% allowed over ${days} day(s)`,
    };
  }
  return { ok: true, drift };
}

/** "25,850.00" to 25850. Empty and "-" mean the bank does not quote it. */
export function parseBankNumber(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const cleaned = raw.replace(/,/g, '').trim();
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Vietcombank stamps its file "9/2/2026 5:38:54 PM" and never says which half
 * is the month.
 *
 * On the 2nd of September both readings parse, and choosing wrong files every
 * rate under 9 February - which a dated lookup would then serve for months. So
 * both readings are built and the one nearer the day we fetched wins. Past the
 * 12th of a month the ambiguity does not arise at all; this only decides the
 * twelve days a year where it does.
 */
export function parseFeedDate(raw: string | null | undefined, fetchedOn: ISODate): ISODate {
  const m = (raw ?? '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return fetchedOn;

  const first = Number(m[1]);
  const second = Number(m[2]);
  const year = Number(m[3]);

  const candidates: ISODate[] = [];
  const build = (month: number, day: number) => {
    if (month < 1 || month > 12 || day < 1 || day > 31) return;
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    // Rejects 31 February and friends: the round trip only survives a real date.
    if (toISODate(parseISODate(iso)) === iso) candidates.push(iso);
  };
  build(first, second); // M/D/Y, which is what Vietcombank actually emits
  build(second, first); // D/M/Y, in case that ever changes

  if (candidates.length === 0) return fetchedOn;

  const target = parseISODate(fetchedOn).getTime();
  let best = candidates[0]!;
  for (const c of candidates) {
    if (
      Math.abs(parseISODate(c).getTime() - target) <
      Math.abs(parseISODate(best).getTime() - target)
    ) {
      best = c;
    }
  }

  // A published date in the future, or older than a fortnight, means the format
  // changed under us. Fall back to the day we fetched rather than guessing.
  const gapDays = (parseISODate(best).getTime() - target) / 86_400_000;
  if (gapDays > 0 || gapDays < -14) return fetchedOn;
  return best;
}

export interface VietcombankFeed {
  asOf: ISODate;
  quotes: BankQuote[];
}

export function parseVietcombank(xml: string, fetchedOn: ISODate = today()): VietcombankFeed {
  const asOf = parseFeedDate((xml.match(/<DateTime>(.*?)<\/DateTime>/) ?? [])[1], fetchedOn);

  const quotes: BankQuote[] = [];
  for (const row of xml.matchAll(/<Exrate\b[^>]*>/g)) {
    const tag = row[0];
    const attr = (name: string) => (tag.match(new RegExp(`${name}="([^"]*)"`)) ?? [])[1];
    const currency = (attr('CurrencyCode') ?? '').trim().toUpperCase();
    if (currency.length !== 3) continue;
    quotes.push({
      currency,
      buy: parseBankNumber(attr('Buy')),
      transfer: parseBankNumber(attr('Transfer')),
      sell: parseBankNumber(attr('Sell')),
    });
  }
  return { asOf, quotes };
}

/**
 * The VND-per-USD figure to value the company's dong at.
 *
 * AHN holds dong and reports in dollars, so the honest question is what those
 * dong would actually fetch. Turning VND into USD means buying dollars from the
 * bank at the bank's SELL price - the dearest of the three columns, and so the
 * fewest dollars. Today that is 26,260 against a mid-market 26,007: a 1%
 * haircut in the direction of understating what AHN has.
 *
 * That direction is deliberate and it matches the rest of the engine. A runway
 * that turns out longer than forecast is a good morning. One that turns out
 * shorter because the books used a rate no bank would honour is the failure
 * this system exists to prevent.
 */
export function vndPerUsd(quotes: BankQuote[]): number | null {
  const usd = quotes.find((q) => q.currency === 'USD');
  if (!usd) return null;
  return usd.sell ?? usd.transfer ?? usd.buy;
}

/**
 * Turn a Vietcombank file into USD-per-unit rates.
 *
 * Vietcombank prices everything in VND, so USD is the pivot: one SGD is worth
 * (VND per SGD) / (VND per USD) dollars, and its own USD row inverts to give
 * VND.
 *
 * Cross rates use the TRANSFER column rather than sell. Sell is the right
 * conservative choice for the dong AHN actually holds; applying a retail cash
 * spread a second time to a currency AHN merely reports in would understate it
 * for no reason.
 */
export function vietcombankUsdRates(feed: VietcombankFeed, wanted: string[]): FeedQuote[] {
  const perUsd = vndPerUsd(feed.quotes);
  if (!perUsd) return [];

  const want = new Set(wanted.map((c) => c.toUpperCase()));
  const out: FeedQuote[] = [];

  if (want.has('VND')) {
    out.push({
      currency: 'VND',
      usdPerUnit: quantiseRate(1 / perUsd),
      asOf: feed.asOf,
      source: 'vietcombank:sell',
    });
  }

  for (const q of feed.quotes) {
    if (q.currency === 'USD' || q.currency === 'VND') continue;
    if (!want.has(q.currency)) continue;
    const vnd = q.transfer ?? q.sell ?? q.buy;
    if (!vnd) continue;
    out.push({
      currency: q.currency,
      usdPerUnit: quantiseRate(vnd / perUsd),
      asOf: feed.asOf,
      source: 'vietcombank:transfer',
    });
  }
  return out;
}

/** exchangerate-api quotes units per USD; the table stores the inverse. */
export function parseFallback(
  json: unknown,
  wanted: string[],
  fetchedOn: ISODate = today(),
): FeedQuote[] {
  const body = json as {
    result?: string;
    rates?: Record<string, number>;
    time_last_update_utc?: string;
  };
  if (body?.result !== 'success' || !body.rates) return [];

  const stamp = body.time_last_update_utc ? new Date(body.time_last_update_utc) : null;
  const asOf = stamp && !Number.isNaN(stamp.getTime()) ? toISODate(stamp) : fetchedOn;

  const out: FeedQuote[] = [];
  for (const currency of new Set(wanted.map((c) => c.toUpperCase()))) {
    if (currency === 'USD') continue;
    const perUsd = body.rates[currency];
    if (typeof perUsd !== 'number' || !Number.isFinite(perUsd) || perUsd <= 0) continue;
    out.push({ currency, usdPerUnit: quantiseRate(1 / perUsd), asOf, source: 'exchangerate-api' });
  }
  return out;
}

/**
 * Fetch every wanted rate, preferring the bank and filling gaps from the
 * mid-market feed.
 *
 * Never throws. A rate feed that takes the scheduler down with it has turned a
 * stale number into an outage, and a stale number is the lesser problem - the
 * dated lookup keeps serving yesterday's rate quite correctly.
 */
export async function fetchQuotes(
  wanted: string[],
  opts: { fetchedOn?: ISODate; timeoutMs?: number } = {},
): Promise<{ quotes: FeedQuote[]; problems: string[] }> {
  const fetchedOn = opts.fetchedOn ?? today();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const problems: string[] = [];
  const byCurrency = new Map<string, FeedQuote>();

  const get = async (url: string): Promise<string | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': 'ahn-financial-os', accept: 'application/json, text/xml, */*' },
        cache: 'no-store',
      });
      if (!res.ok) {
        problems.push(`${new URL(url).hostname} answered ${res.status}`);
        return null;
      }
      return await res.text();
    } catch (e) {
      problems.push(`${new URL(url).hostname} unreachable: ${(e as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const xml = await get(VIETCOMBANK_URL);
  if (xml) {
    for (const q of vietcombankUsdRates(parseVietcombank(xml, fetchedOn), wanted)) {
      byCurrency.set(q.currency, q);
    }
  }

  // Only ask the fallback for what the bank did not price. Vietcombank lists
  // twenty currencies; anything outside that set is what this is for.
  const missing = wanted
    .map((c) => c.toUpperCase())
    .filter((c) => c !== 'USD' && !byCurrency.has(c));

  if (missing.length > 0) {
    const body = await get(FALLBACK_URL);
    if (body) {
      try {
        for (const q of parseFallback(JSON.parse(body), missing, fetchedOn)) {
          byCurrency.set(q.currency, q);
        }
      } catch (e) {
        problems.push(`fallback feed was not JSON: ${(e as Error).message}`);
      }
    }
  }

  const stillMissing = wanted
    .map((c) => c.toUpperCase())
    .filter((c) => c !== 'USD' && !byCurrency.has(c));
  for (const c of stillMissing) problems.push(`no source priced ${c}`);

  return { quotes: [...byCurrency.values()], problems };
}
