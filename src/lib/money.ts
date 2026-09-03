/**
 * Money primitives.
 *
 * Spec section 9 and 28 demand numbers that reconcile to the bank exactly, so
 * nothing in this file uses floating-point arithmetic to hold a balance. Every
 * amount is an integer count of the currency MINOR unit:
 *
 *   USD 1,234.56  ->  123456   (2 minor digits)
 *   VND 1,234,567 ->  1234567  (0 minor digits)
 *
 * JS numbers hold integers exactly up to 2^53, which is ~90 trillion USD cents
 * and ~9 quadrillion VND - far beyond anything AHN will transact - so a plain
 * `number` is safe here as long as it stays integral.
 */

export const MINOR_DIGITS: Record<string, number> = {
  USD: 2,
  VND: 0,
  PHP: 2,
  EUR: 2,
  GBP: 2,
  SGD: 2,
  JPY: 0,
  AUD: 2,
  CAD: 2,
};

export const DEFAULT_CURRENCY = 'USD';

export function minorDigits(currency: string): number {
  return MINOR_DIGITS[currency.toUpperCase()] ?? 2;
}

/** Half-away-from-zero, the rounding convention finance expects. */
export function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Major units (dollars) -> minor units (cents).
 *
 * The `toPrecision(15)` pass is not decoration. Scaling by a power of ten
 * reintroduces exactly the representation error this module exists to avoid:
 * `19.99 * 100` is `1998.9999999999998` and `1.005 * 100` is
 * `100.49999999999999`, so a plain round would book 19.99 correctly but turn
 * 1.005 into 1.00. Rounding to 15 significant digits first snaps the value back
 * to the decimal the source actually meant, then the money rounding applies.
 */
export function toMinor(major: number, currency = DEFAULT_CURRENCY): number {
  const scaled = major * 10 ** minorDigits(currency);
  if (!Number.isFinite(scaled)) return 0;
  return roundHalfUp(Number(scaled.toPrecision(15)));
}

/** Minor units (cents) -> major units (dollars). Display only - never sum these. */
export function toMajor(minor: number, currency = DEFAULT_CURRENCY): number {
  return minor / 10 ** minorDigits(currency);
}

/**
 * Parse an amount out of a CSV cell or a form field.
 *
 * Handles the shapes that actually turn up in AHN statements:
 *   "$1,234.56"   "1,234.56"   "(1,234.56)"   "-1234.56"   "1.234.567"  (VN)
 *   "1.234,56"    (European / some VN exports)
 *   "275.000"     (VN, ONE grouping dot - see the zero-decimal branch below)
 *
 * Returns null when the cell holds no parseable number, so the import can put
 * that row in the error bucket instead of silently booking a zero.
 */
export function parseAmount(
  raw: string | number | null | undefined,
  opts: { decimalSeparator?: '.' | ','; currency?: string } = {},
): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;

  let s = raw.trim();
  if (!s) return null;

  // Accounting negatives: (1,234.56)
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }

  // Strip currency symbols, codes and spaces (incl. non-breaking).
  s = s.replace(/[\s ]/g, '').replace(/[$€£₫]|USD|VND|PHP/gi, '');

  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (!s) return null;

  // A currency with no subunit cannot have a decimal separator at all, so every
  // dot and comma in it is a grouping mark - UNLESS the trailing group is not
  // three digits, which means whoever wrote it meant a decimal point after all.
  //
  // This is not a stylistic preference. "275.000" in the VN bank statement
  // template is 275,000 dong; the general path below reads it as 275, because a
  // single dot followed by three digits is exactly as valid a decimal as it is
  // a separator. Every VND amount with one grouping mark was landing in the
  // ledger a THOUSAND times too small, and 275 next to 275,000 looks like a
  // small fee either way.
  if (minorDigits(opts.currency ?? DEFAULT_CURRENCY) === 0) {
    if (isGroupedInteger(s)) return applySign(Number(s.replace(/[.,]/g, '')), negative);
  }

  const sep = opts.decimalSeparator ?? inferDecimalSeparator(s);
  if (sep === ',') {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }

  // A VN-style "1.234.567" collapses to "1234567" above only when the comma
  // path ran. If dots remain and there is more than one, they were separators.
  const dotCount = (s.match(/\./g) ?? []).length;
  if (dotCount > 1) s = s.replace(/\./g, '');

  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;

  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/**
 * True when every separator in the string marks a group of exactly three
 * digits: "1.234.567", "275.000", "1,234,567".
 *
 * "275.00" is NOT grouped - the trailing run is two digits - so a zero-decimal
 * currency written with two decimal places is still read as 275 rather than
 * inflated a hundredfold.
 */
function isGroupedInteger(s: string): boolean {
  return /^\d{1,3}([.,]\d{3})+$/.test(s);
}

function applySign(value: number, negative: boolean): number | null {
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

function inferDecimalSeparator(s: string): '.' | ',' {
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastComma > lastDot) return ',';
  return '.';
}

/** Parse straight into minor units. */
export function parseAmountToMinor(
  raw: string | number | null | undefined,
  currency = DEFAULT_CURRENCY,
  opts: { decimalSeparator?: '.' | ',' } = {},
): number | null {
  const major = parseAmount(raw, { ...opts, currency });
  return major === null ? null : toMinor(major, currency);
}

/**
 * Convert between currencies using a dated rate (quote units per 1 base unit).
 * Works in minor units on both sides, accounting for the differing minor digits
 * (USD has 2, VND has 0).
 */
export function convertMinor(
  amountMinor: number,
  fromCurrency: string,
  toCurrency: string,
  rate: number,
): number {
  if (fromCurrency.toUpperCase() === toCurrency.toUpperCase()) return amountMinor;
  const scale = 10 ** (minorDigits(toCurrency) - minorDigits(fromCurrency));
  return roundHalfUp(amountMinor * rate * scale);
}

export interface FormatOptions {
  /** Show cents. Defaults to true for USD-like, false for VND. */
  showMinor?: boolean;
  /** Prefix positive values with "+". Useful in alert copy. */
  signed?: boolean;
  /** 284300 -> "$2.8k". For dense dashboard tiles. */
  compact?: boolean;
}

const SYMBOLS: Record<string, string> = { USD: '$', VND: '₫', PHP: '₱', EUR: '€', GBP: '£' };

/** Format minor units for display. */
export function formatMoney(
  amountMinor: number | null | undefined,
  currency = DEFAULT_CURRENCY,
  opts: FormatOptions = {},
): string {
  const cur = currency.toUpperCase();
  if (amountMinor === null || amountMinor === undefined || !Number.isFinite(amountMinor)) {
    return `${SYMBOLS[cur] ?? ''}—`;
  }
  const digits = minorDigits(cur);
  const symbol = SYMBOLS[cur] ?? `${cur} `;
  const negative = amountMinor < 0;
  const major = Math.abs(amountMinor) / 10 ** digits;

  let body: string;
  if (opts.compact && major >= 10000) {
    body = compactNumber(major);
  } else {
    const showMinor = opts.showMinor ?? digits > 0;
    body = major.toLocaleString('en-US', {
      minimumFractionDigits: showMinor ? digits : 0,
      maximumFractionDigits: showMinor ? digits : 0,
    });
  }

  const sign = negative ? '−' : opts.signed ? '+' : '';
  return `${sign}${symbol}${body}`;
}

function compactNumber(major: number): string {
  const units: Array<[number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [size, suffix] of units) {
    if (major >= size) {
      // One decimal always: on a cash tile, "$284.3k" and "$284k" are $300
      // apart, and the reader has no way to tell which they are looking at.
      const scaled = major / size;
      return `${scaled.toFixed(1).replace(/\.0$/, '')}${suffix}`;
    }
  }
  return major.toFixed(0);
}

/** "7.8 months" / "∞" when burn is zero. */
export function formatMonths(months: number | null): string {
  if (months === null || !Number.isFinite(months)) return '∞';
  return `${months.toFixed(1)} months`;
}

export function formatPercent(ratio: number | null, digits = 1): string {
  if (ratio === null || !Number.isFinite(ratio)) return '—';
  // The same minus sign `formatMoney` uses, not an ASCII hyphen. The two sit in
  // adjacent columns of the same table, and a row reading "−$500.00  -8%" makes
  // a reader stop on the typography instead of the number.
  const magnitude = Math.abs(ratio * 100).toFixed(digits);
  // "−0%" is not a thing. A value that rounds away to nothing is not negative.
  const sign = ratio < 0 && Number(magnitude) !== 0 ? '−' : '';
  return `${sign}${magnitude}%`;
}

/** Sum helper that keeps the "integers only" invariant obvious at call sites. */
export function sumMinor(values: Array<number | null | undefined>): number {
  let total = 0;
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) total += v;
  return total;
}
