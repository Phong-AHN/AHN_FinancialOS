import { describe, expect, it } from 'vitest';
import {
  currencyOf,
  mergeReviewRows,
  normaliseTime,
  reviewScreenshot,
  statusOf,
  type ScreenshotReading,
  type ScreenshotRow,
} from '@/lib/image-import/review';
import { MAX_LONG_EDGE, MAX_VISUAL_TOKENS, planSlices, visualTokens } from '@/lib/image-import/slices';

/**
 * The second round of screenshot-import fixes: images the model would have
 * downscaled into illegibility, a cut-off card left as a blocked duplicate,
 * typed times the server refused, and currency words the checks missed.
 */

const TODAY = '2026-09-11';

const qpt: ScreenshotRow = {
  reference: '1031926H25810864',
  transfer_type: 'Nhanh 24/7',
  amount_text: '9,396,000 VND',
  amount: 9_396_000,
  currency: 'VND',
  direction: 'outflow',
  direction_evidence: 'Chuyển tiền — Chuyển tới',
  counterparty_name: 'CT TNHH DAI LY THUE Q.P.T',
  counterparty_bank: 'Ngân hàng Ngoại thương Việt Nam (VCB)',
  counterparty_account: '0181003502766',
  description: 'AHNG thanh toan cong no QPT',
  datetime_text: '25/08/2026 11:30:21',
  status_text: 'Thành công',
  cut_off: false,
};

const screen = (rows: ScreenshotRow[]): ScreenshotReading => ({
  bank: 'VietinBank',
  screen_title: 'Yêu cầu của tôi',
  tab: 'Đã duyệt',
  is_transaction_list: true,
  shows_posted_transactions: false,
  rows,
});

describe('fitting an image to what the model reads at full detail', () => {
  const within = (w: number, h: number) => Math.max(w, h) <= MAX_LONG_EDGE && visualTokens(w, h) <= MAX_VISUAL_TOKENS;

  it('leaves the sample screenshot alone', () => {
    expect(planSlices(1169, 2370)).toEqual({ scale: 1, width: 1169, slices: [{ top: 0, height: 2370 }] });
  });

  it('shrinks a slightly-too-large phone screenshot a little instead of cutting it', () => {
    const plan = planSlices(1290, 2796);
    expect(plan.slices).toHaveLength(1);
    expect(plan.scale).toBeGreaterThan(0.75);
    expect(within(plan.width, plan.slices[0]!.height)).toBe(true);
  });

  it.each([
    [1170, 8000],
    [1290, 12_000],
    [750, 5000],
    [1080, 4000],
  ])('cuts a %dx%d scrolling capture into readable, overlapping tiles', (w, h) => {
    const plan = planSlices(w, h);
    expect(plan.slices.length).toBeGreaterThan(1);
    // Never shrunk to the sliver the first version produced.
    expect(plan.width).toBeGreaterThanOrEqual(Math.min(w, 700));
    const total = Math.round(h * plan.scale);
    for (const [i, s] of plan.slices.entries()) {
      expect(within(plan.width, s.height), `tile ${i} over the limit`).toBe(true);
      expect(s.top + s.height).toBeLessThanOrEqual(total);
      if (i > 0) {
        const prev = plan.slices[i - 1]!;
        // Each overlap is at least half a screen width — taller than a card.
        expect(prev.top + prev.height - s.top).toBeGreaterThanOrEqual(Math.floor(plan.width * 0.5));
      }
    }
    expect(plan.slices[0]!.top).toBe(0);
    const last = plan.slices[plan.slices.length - 1]!;
    expect(last.top + last.height).toBe(total); // nothing below the last tile is lost
  });

  it('shrinks a wide image rather than cutting it', () => {
    const plan = planSlices(4000, 1500);
    expect(plan.slices).toHaveLength(1);
    expect(within(plan.width, plan.slices[0]!.height)).toBe(true);
  });
});

describe('a card cut off without its date', () => {
  it('is folded into the same transfer seen whole in the next screenshot', () => {
    const partial = reviewScreenshot(
      screen([{ ...qpt, reference: null, datetime_text: null, status_text: null, cut_off: true }]),
      0,
      { today: TODAY },
    );
    const whole = reviewScreenshot(screen([qpt]), 1, { today: TODAY });
    const merged = mergeReviewRows([...partial, ...whole]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ txnDate: '2026-08-25', images: [0, 1] });
  });

  it('stays, for a person to date, when nothing identifies it', () => {
    const partial = reviewScreenshot(
      screen([{ ...qpt, reference: null, counterparty_account: null, counterparty_name: 'SOMEONE ELSE', datetime_text: null, cut_off: true }]),
      0,
      { today: TODAY },
    );
    const whole = reviewScreenshot(screen([qpt]), 1, { today: TODAY });
    expect(mergeReviewRows([...partial, ...whole])).toHaveLength(2);
  });
});

describe('a time typed by a person', () => {
  it.each([
    ['9:03', '09:03'],
    ['16:29:12', '16:29:12'],
    [' 07:05 ', '07:05'],
    ['', null],
  ])('"%s" → %s', (typed, expected) => {
    expect(normaliseTime(typed)).toBe(expected);
  });

  it.each(['24:00', '9h03', '12:60', '1:2'])('refuses "%s"', (typed) => {
    expect(normaliseTime(typed)).toBeUndefined();
  });
});

describe('currency and status words', () => {
  it.each([
    ['6.500.000 đ', 'VND'],
    ['6.500.000đ', 'VND'],
    ['$12.50', 'USD'],
  ])('%s is %s', (text, expected) => {
    expect(currencyOf(text, text.startsWith('$') ? 'USD' : 'USD')).toBe(expected);
  });

  it.each(['Đã từ chối', 'Hết hạn', 'Giao dịch lỗi', 'Chờ xác nhận'])('"%s" did not move money', (text) => {
    expect(statusOf(text, false)).toBe('not_successful');
  });
});
