import { describe, expect, it } from 'vitest';
import {
  convertMinor,
  formatMoney,
  formatMonths,
  formatPercent,
  parseAmount,
  parseAmountToMinor,
  roundHalfUp,
  toMinor,
} from '@/lib/money';

describe('minor-unit conversion', () => {
  it('converts USD major to cents', () => {
    expect(toMinor(1234.56, 'USD')).toBe(123456);
    expect(toMinor(0.1, 'USD')).toBe(10);
  });

  it('treats VND as a zero-decimal currency', () => {
    expect(toMinor(1_234_567, 'VND')).toBe(1_234_567);
  });

  it('avoids the classic float error on 0.1 + 0.2 style amounts', () => {
    // 19.99 * 100 is 1998.9999999999998 in IEEE754. Truncation would lose a cent
    // on every subscription line, and those cents end up in the runway figure.
    expect(toMinor(19.99, 'USD')).toBe(1999);
    expect(toMinor(0.29, 'USD')).toBe(29);
    expect(toMinor(1.005, 'USD')).toBe(101);
  });

  it('rounds half away from zero, the finance convention', () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-2.5)).toBe(-3);
  });
});

describe('parseAmount', () => {
  it('reads plain and formatted US amounts', () => {
    expect(parseAmount('1234.56')).toBe(1234.56);
    expect(parseAmount('$1,234.56')).toBe(1234.56);
    expect(parseAmount('  1,234.56  ')).toBe(1234.56);
  });

  it('reads accounting negatives', () => {
    expect(parseAmount('(1,234.56)')).toBe(-1234.56);
    expect(parseAmount('-1234.56')).toBe(-1234.56);
  });

  it('reads VN-style thousands separators', () => {
    expect(parseAmount('1.234.567', { decimalSeparator: ',' })).toBe(1234567);
    expect(parseAmount('1.234,56', { decimalSeparator: ',' })).toBe(1234.56);
  });

  it('returns null rather than zero for unreadable cells', () => {
    // Booking an unreadable row as zero is how a statement silently imports
    // short. The import surfaces these as errors instead.
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('n/a')).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount('--')).toBeNull();
  });

  it('parses straight to minor units for the target currency', () => {
    expect(parseAmountToMinor('1,234.56', 'USD')).toBe(123456);
    expect(parseAmountToMinor('1.234.567', 'VND', { decimalSeparator: ',' })).toBe(1234567);
  });
});

describe('convertMinor', () => {
  it('handles differing minor digits between currencies', () => {
    // 1,000,000 VND at 0.000038 USD/VND is 38.00 USD -> 3800 cents.
    expect(convertMinor(1_000_000, 'VND', 'USD', 0.000038)).toBe(3800);
    // 100.00 USD at 26,000 VND/USD is 2,600,000 VND (zero decimals).
    expect(convertMinor(10_000, 'USD', 'VND', 26_000)).toBe(2_600_000);
  });

  it('is a no-op for a same-currency conversion', () => {
    expect(convertMinor(12345, 'USD', 'USD', 999)).toBe(12345);
  });
});

describe('formatting', () => {
  it('formats USD with cents and VND without', () => {
    expect(formatMoney(123456, 'USD')).toBe('$1,234.56');
    expect(formatMoney(1_234_567, 'VND')).toBe('₫1,234,567');
  });

  it('uses a real minus sign for negatives', () => {
    expect(formatMoney(-123456, 'USD')).toBe('−$1,234.56');
  });

  it('compacts large numbers for dense tiles', () => {
    expect(formatMoney(28_430_000, 'USD', { compact: true })).toBe('$284.3k');
  });

  it('shows infinite runway when nothing is going out', () => {
    expect(formatMonths(null)).toBe('∞');
    expect(formatMonths(7.84)).toBe('7.8 months');
  });
});

describe('formatPercent', () => {
  it('uses the same minus sign as formatMoney', () => {
    // They sit in adjacent columns of the same table. A row reading
    // "−$500.00  -8%" makes a reader stop on the typography, not the number.
    expect(formatPercent(-0.08, 0)).toBe('−8%');
    expect(formatMoney(-50_000)).toBe('−$500.00');
  });

  it('does not render a negative zero', () => {
    // −0.04% rounded to a whole percent is nothing, and "−0%" is not a thing.
    expect(formatPercent(-0.0004, 0)).toBe('0%');
    expect(formatPercent(-0.004, 1)).toBe('−0.4%');
  });

  it('says nothing rather than zero when there is no ratio', () => {
    // A margin on no revenue is unknown, not break-even.
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(Number.NaN)).toBe('—');
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('still formats a positive ratio plainly', () => {
    expect(formatPercent(0.2285, 0)).toBe('23%');
    expect(formatPercent(1)).toBe('100.0%');
  });
});

describe('zero-decimal currencies (VND)', () => {
  it('reads a single grouping dot as thousands, not as a decimal point', () => {
    // The bug this exists for: "275.000" is 275,000 dong — a bank fee line in
    // samples/vn-bank-statement.csv. The general path read it as 275, because
    // one dot followed by three digits is exactly as valid a decimal as it is a
    // separator. Every VND amount with one grouping mark was landing in the
    // ledger a THOUSAND times too small, and 275 beside 275,000 still looks
    // like a plausible small fee.
    expect(parseAmount('275.000', { currency: 'VND' })).toBe(275_000);
    expect(parseAmountToMinor('275.000', 'VND')).toBe(275_000);
  });

  it('still reads multiple grouping marks correctly', () => {
    expect(parseAmount('412.500.000', { currency: 'VND' })).toBe(412_500_000);
    expect(parseAmount('1.234.567', { currency: 'VND' })).toBe(1_234_567);
    expect(parseAmount('1,234,567', { currency: 'VND' })).toBe(1_234_567);
  });

  it('does not inflate an amount someone wrote with two decimal places', () => {
    // "275.00" is not grouped — the trailing run is two digits — so it stays
    // 275 rather than becoming 27,500. VND has no subunit either way.
    expect(parseAmount('275.00', { currency: 'VND' })).toBe(275);
    expect(parseAmount('275.5', { currency: 'VND' })).toBe(275.5);
  });

  it('leaves USD alone', () => {
    // The same string means something different in a currency that HAS cents,
    // so the grouping rule is scoped to zero-decimal currencies only.
    expect(parseAmount('275.000', { currency: 'USD' })).toBe(275);
    expect(parseAmount('1.234', { currency: 'USD' })).toBe(1.234);
    expect(parseAmount('1,234.56', { currency: 'USD' })).toBe(1234.56);
  });

  it('keeps signs and accounting parentheses', () => {
    expect(parseAmount('-412.500.000', { currency: 'VND' })).toBe(-412_500_000);
    expect(parseAmount('(275.000)', { currency: 'VND' })).toBe(-275_000);
  });

  it('parses every amount in the VN bank template', () => {
    const rows: Array<[string, number]> = [
      ['412.500.000', 412_500_000],
      ['8.450.000', 8_450_000],
      ['430.000.000', 430_000_000],
      ['275.000', 275_000],
      ['3.120.000', 3_120_000],
      ['185.000.000', 185_000_000],
    ];
    for (const [raw, expected] of rows) {
      expect(parseAmountToMinor(raw, 'VND'), raw).toBe(expected);
    }
  });
});
