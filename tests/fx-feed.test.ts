import { describe, expect, it } from 'vitest';
import {
  driftAllowance,
  isPlausible,
  parseBankNumber,
  parseFallback,
  parseFeedDate,
  parseVietcombank,
  quantiseRate,
  vietcombankUsdRates,
  vndPerUsd,
} from '@/lib/fx-feed';

/** Trimmed from a real response, including the quirks it actually contains. */
const VCB_XML = `<!--For reference only. Only one request every 5 minutes!-->
<ExrateList>
  <DateTime>9/2/2026 5:38:54 PM</DateTime>
  <Exrate CurrencyCode="AUD" CurrencyName="AUSTRALIAN DOLLAR   " Buy="18,270.20" Transfer="18,454.74" Sell="19,060.63" />
  <Exrate CurrencyCode="JPY" CurrencyName="YEN                 " Buy="157.55" Transfer="159.14" Sell="168.55" />
  <Exrate CurrencyCode="KWD" CurrencyName="KUWAITI DINAR       " Buy="" Transfer="" Sell="88,000.00" />
  <Exrate CurrencyCode="SGD" CurrencyName="SINGAPORE DOLLAR    " Buy="19,969.80" Transfer="20,171.51" Sell="20,875.48" />
  <Exrate CurrencyCode="USD" CurrencyName="US DOLLAR           " Buy="25,850.00" Transfer="25,880.00" Sell="26,260.00" />
  <Source>Joint Stock Commercial Bank for Foreign Trade of Vietnam - Vietcombank</Source>
</ExrateList>`;

describe('parseBankNumber', () => {
  it('strips the thousands separators a bank quotes with', () => {
    expect(parseBankNumber('25,850.00')).toBe(25850);
    expect(parseBankNumber('157.55')).toBe(157.55);
  });

  it('treats a column the bank does not quote as absent, not as zero', () => {
    // Vietcombank leaves Buy empty for currencies it will not buy in cash. A
    // zero here would divide into an infinite rate.
    expect(parseBankNumber('')).toBeNull();
    expect(parseBankNumber('-')).toBeNull();
    expect(parseBankNumber(undefined)).toBeNull();
    expect(parseBankNumber('0')).toBeNull();
  });
});

describe('parseVietcombank', () => {
  it('reads every currency row', () => {
    const feed = parseVietcombank(VCB_XML, '2026-09-02');
    expect(feed.quotes.map((q) => q.currency)).toEqual(['AUD', 'JPY', 'KWD', 'SGD', 'USD']);
  });

  it('keeps a partially quoted currency rather than dropping it', () => {
    const kwd = parseVietcombank(VCB_XML, '2026-09-02').quotes.find((q) => q.currency === 'KWD');
    expect(kwd).toEqual({ currency: 'KWD', buy: null, transfer: null, sell: 88_000 });
  });

  it('values the dong at the rate a bank would actually sell dollars for', () => {
    // AHN holds dong and reports dollars. Converting means BUYING dollars from
    // the bank, at the bank's sell price — the dearest column, fewest dollars.
    expect(vndPerUsd(parseVietcombank(VCB_XML, '2026-09-02').quotes)).toBe(26_260);
  });
});

describe('vietcombankUsdRates', () => {
  const feed = parseVietcombank(VCB_XML, '2026-09-02');

  it('inverts the dollar row to price the dong', () => {
    const vnd = vietcombankUsdRates(feed, ['VND'])[0]!;
    // Rounded to the ten decimal places the column stores, so the value here
    // and the value in the database are the same number. Asserted exactly
    // rather than approximately, because "approximately equal" is what let the
    // unchanged branch go dead.
    expect(vnd.usdPerUnit).toBe(quantiseRate(1 / 26_260));
    expect(vnd.usdPerUnit).toBe(0.0000380807);
    expect(vnd.source).toBe('vietcombank:sell');
  });

  it('crosses through the dong to price everything else', () => {
    // One Singapore dollar is (VND per SGD) / (VND per USD) US dollars.
    const sgd = vietcombankUsdRates(feed, ['SGD'])[0]!;
    expect(sgd.usdPerUnit).toBe(quantiseRate(20_171.51 / 26_260));
    // Transfer, not sell: a retail cash spread applied twice would understate a
    // currency AHN merely reports in, for no reason.
    expect(sgd.source).toBe('vietcombank:transfer');
  });

  it('asks for nothing it was not asked for', () => {
    expect(vietcombankUsdRates(feed, ['VND']).map((q) => q.currency)).toEqual(['VND']);
  });

  it('returns nothing at all if the dollar row is missing', () => {
    // Without the pivot every cross rate would be nonsense, so none is offered.
    const noUsd = parseVietcombank(VCB_XML.replace(/<Exrate CurrencyCode="USD".*?\/>/s, ''), '2026-09-02');
    expect(vietcombankUsdRates(noUsd, ['VND', 'SGD'])).toEqual([]);
  });
});

describe('quantiseRate', () => {
  it('rounds to what the column can actually hold', () => {
    // numeric(20,10). Anything finer is silently truncated on the way in, and
    // then never matches what the code is holding.
    expect(quantiseRate(0.00003808073115003808)).toBe(0.0000380807);
    expect(quantiseRate(1)).toBe(1);
  });

  it('survives a round trip through the database scale', () => {
    // The property that matters: quantise twice and nothing moves, so a stored
    // rate read back and re-quantised compares equal to itself.
    const once = quantiseRate(1 / 26_260);
    expect(quantiseRate(once)).toBe(once);
  });
});

describe('parseFeedDate', () => {
  it('reads the bank stamp as month-first, which is what it emits', () => {
    expect(parseFeedDate('9/2/2026 5:38:54 PM', '2026-09-02')).toBe('2026-09-02');
  });

  it('resolves an ambiguous stamp toward the day we fetched it', () => {
    // The same eight characters on a different day mean the other thing. Filing
    // September's rate under 9 February would have a dated lookup serve it for
    // seven months.
    expect(parseFeedDate('9/2/2026 8:00:00 AM', '2026-02-09')).toBe('2026-02-09');
  });

  it('falls back to the fetch date rather than filing a rate in the future', () => {
    expect(parseFeedDate('12/25/2026 9:00:00 AM', '2026-09-02')).toBe('2026-09-02');
  });

  it('falls back when the stamp is far older than the fetch, meaning the format moved', () => {
    expect(parseFeedDate('1/2/2026 9:00:00 AM', '2026-09-02')).toBe('2026-09-02');
  });

  it('falls back on an unparseable or missing stamp', () => {
    expect(parseFeedDate('yesterday', '2026-09-02')).toBe('2026-09-02');
    expect(parseFeedDate(null, '2026-09-02')).toBe('2026-09-02');
  });

  it('rejects a date that does not exist', () => {
    expect(parseFeedDate('2/31/2026 9:00:00 AM', '2026-09-02')).toBe('2026-09-02');
  });
});

describe('isPlausible', () => {
  const yesterday = { rate: 0.000038, asOf: '2026-09-01' };

  it('accepts a normal day of movement', () => {
    const verdict = isPlausible(1 / 26_260, yesterday, '2026-09-02');
    expect(verdict.ok).toBe(true);
    expect(verdict.drift!).toBeLessThan(0.01);
  });

  it('refuses the pair quoted upside down', () => {
    // The whole reason this guard exists. 26,260 USD per dong would multiply
    // every VND balance in the company by seven hundred million.
    const verdict = isPlausible(26_260, yesterday, '2026-09-02');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('inverted');
  });

  it('refuses a rate that belongs to a different currency', () => {
    // A parser that picked up the neighbouring row: won per dollar, not dong.
    const verdict = isPlausible(1 / 1_374, yesterday, '2026-09-02');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('more than the');
  });

  it('allows more movement the longer the feed has been down', () => {
    // A feed that has been silent a fortnight must not reject a fortnight of
    // genuine drift the moment it comes back.
    const stale = { rate: 0.000038, asOf: '2026-08-03' };
    const eightPercent = 0.000038 * 1.08;
    expect(isPlausible(eightPercent, yesterday, '2026-09-02').ok).toBe(false);
    expect(isPlausible(eightPercent, stale, '2026-09-02').ok).toBe(true);
  });

  it('never allows an unlimited move however long the gap', () => {
    const ancient = { rate: 0.000038, asOf: '2020-01-01' };
    expect(driftAllowance(2_000)).toBe(0.25);
    expect(isPlausible(0.000038 * 2, ancient, '2026-09-02').ok).toBe(false);
  });

  it('applies only the absolute band when nothing is on file yet', () => {
    expect(isPlausible(1 / 26_260, null, '2026-09-02').ok).toBe(true);
    expect(isPlausible(26_260, null, '2026-09-02').ok).toBe(false);
  });

  it('refuses zero, negative and NaN outright', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isPlausible(bad, yesterday, '2026-09-02').ok, String(bad)).toBe(false);
    }
  });
});

describe('parseFallback', () => {
  const body = {
    result: 'success',
    time_last_update_utc: 'Wed, 02 Sep 2026 00:02:31 +0000',
    rates: { USD: 1, VND: 26_007.437228, KRW: 1_374.61, BROKEN: 'x' },
  };

  it('inverts units-per-USD into the USD-per-unit the table stores', () => {
    const vnd = parseFallback(body, ['VND'])[0]!;
    expect(vnd.usdPerUnit).toBe(quantiseRate(1 / 26_007.437228));
    expect(vnd.asOf).toBe('2026-09-02');
    expect(vnd.source).toBe('exchangerate-api');
  });

  it('never emits a row for USD against itself', () => {
    expect(parseFallback(body, ['USD', 'VND']).map((q) => q.currency)).toEqual(['VND']);
  });

  it('skips a currency whose rate is not a number', () => {
    expect(parseFallback(body, ['BROKEN'])).toEqual([]);
  });

  it('returns nothing when the provider did not report success', () => {
    expect(parseFallback({ ...body, result: 'error' }, ['VND'])).toEqual([]);
    expect(parseFallback(null, ['VND'])).toEqual([]);
  });

  it('uses the fetch date when the provider sends no usable stamp', () => {
    const noStamp = { result: 'success', rates: { VND: 26_000 } };
    expect(parseFallback(noStamp, ['VND'], '2026-09-02')[0]!.asOf).toBe('2026-09-02');
  });
});
