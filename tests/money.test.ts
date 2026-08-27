import { describe, expect, it } from 'vitest';
import {
  convertMinor,
  formatMoney,
  formatMonths,
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
