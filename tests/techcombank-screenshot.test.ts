import { describe, expect, it } from 'vitest';
import {
  importable,
  mergeReviewRows,
  reviewScreenshot,
  rowKey,
  statusOf,
  externalIdFor,
  type ScreenshotReading,
  type ScreenshotRow,
} from '@/lib/image-import/review';

/**
 * Techcombank screenshots, which differ from VietinBank's in the three ways
 * that matter to this importer:
 *
 *   1. the reference is "Mã giao dịch" and sits inside the card, not above it;
 *   2. the history list prints HH:MM with no seconds, so two transfers of the
 *      same amount in the same minute are only told apart by something else;
 *   3. it says "Hoàn tất" and "Chuyển tiền thành công" where VietinBank says
 *      "Thành công".
 *
 * The transcriptions below are of a Techcombank history screen: two outgoing
 * transfers and one incoming payment.
 */

const TODAY = '2026-11-10';

const tcbOut: ScreenshotRow = {
  reference: 'FT26314090112233',
  transfer_type: 'Chuyển tiền nhanh 24/7',
  amount_text: '-2.500.000 đ',
  amount: 2_500_000,
  currency: 'VND',
  direction: 'outflow',
  direction_evidence: 'dấu − và "Tiền ra"',
  counterparty_name: 'NGUYEN VAN AN',
  counterparty_bank: 'Vietcombank',
  counterparty_account: '0071001234567',
  description: 'AHN thanh toan thiet ke',
  datetime_text: '09/11/2026 14:32',
  status_text: 'Hoàn tất',
  cut_off: false,
};

const tcbIn: ScreenshotRow = {
  reference: 'FT26314090144556',
  transfer_type: 'Nhận tiền',
  amount_text: '+18.000.000 đ',
  amount: 18_000_000,
  currency: 'VND',
  direction: 'inflow',
  direction_evidence: 'dấu + và "Tiền vào"',
  counterparty_name: 'CONG TY TNHH ABC',
  counterparty_bank: 'Techcombank',
  counterparty_account: '19033456789012',
  description: 'ABC thanh toan hop dong 11/2026',
  datetime_text: '09/11/2026 09:05',
  status_text: 'Giao dịch thành công',
  cut_off: false,
};

const tcbScreen = (rows: ScreenshotRow[]): ScreenshotReading => ({
  bank: 'Techcombank',
  screen_title: 'Lịch sử giao dịch',
  tab: null,
  is_transaction_list: true,
  shows_posted_transactions: true,
  rows,
});

describe('a Techcombank history screen', () => {
  const rows = reviewScreenshot(tcbScreen([tcbOut, tcbIn]), 0, { today: TODAY });

  it('reads the dong amounts whichever separator the app uses', () => {
    expect(rows.map((r) => [r.amountMinor, r.direction])).toEqual([
      [2_500_000, 'outflow'],
      [18_000_000, 'inflow'],
    ]);
  });

  it('keeps the time as printed, without inventing seconds', () => {
    expect(rows[0]).toMatchObject({ txnDate: '2026-11-09', time: '14:32' });
  });

  it('accepts "Hoàn tất" and "Giao dịch thành công" as money that moved', () => {
    expect(statusOf('Hoàn tất', false)).toBe('successful');
    expect(statusOf('Chuyển tiền thành công', false)).toBe('successful');
    expect(rows.every(importable)).toBe(true);
  });

  it('still refuses a Techcombank row that has not completed', () => {
    const [pending] = reviewScreenshot(tcbScreen([{ ...tcbOut, status_text: 'Đang xử lý' }]), 0, {
      today: TODAY,
    });
    expect(importable(pending!)).toBe(false);
  });
});

describe('two transfers in the same minute, which is what a missing second costs', () => {
  it('keeps them apart by their transaction numbers', () => {
    const twin = { ...tcbOut, reference: 'FT26314090199999', description: 'AHN dot 2' };
    const rows = reviewScreenshot(tcbScreen([tcbOut, twin]), 0, { today: TODAY });
    expect(mergeReviewRows(rows)).toHaveLength(2);
  });

  it('keeps them apart by the receiving account when neither shows a number', () => {
    const a = { ...tcbOut, reference: null };
    const b = { ...tcbOut, reference: null, counterparty_account: '0071009999999' };
    expect(mergeReviewRows(reviewScreenshot(tcbScreen([a, b]), 0, { today: TODAY }))).toHaveLength(2);
  });

  it('treats a genuinely identical row as one transaction', () => {
    const rows = reviewScreenshot(tcbScreen([tcbOut, { ...tcbOut }]), 0, { today: TODAY });
    expect(mergeReviewRows(rows)).toHaveLength(1);
  });
});

describe('importing the same statement twice', () => {
  it('produces the same ledger id both times, so the second import adds nothing', () => {
    const first = reviewScreenshot(tcbScreen([tcbOut, tcbIn]), 0, { today: TODAY });
    const second = reviewScreenshot(tcbScreen([tcbOut, tcbIn]), 0, { today: TODAY });
    const ids = (rows: typeof first) => rows.map((r) => externalIdFor('acct-1111', r.key));
    expect(ids(first)).toEqual(ids(second));
  });

  it('gives the same transfer in two accounts two different ids', () => {
    const [row] = reviewScreenshot(tcbScreen([tcbOut]), 0, { today: TODAY });
    expect(externalIdFor('acct-1111', row!.key)).not.toBe(externalIdFor('acct-2222', row!.key));
  });

  it('merges the same transfer seen in two overlapping screenshots', () => {
    const first = reviewScreenshot(tcbScreen([tcbOut, tcbIn]), 0, { today: TODAY });
    const scrolled = reviewScreenshot(tcbScreen([tcbIn]), 1, { today: TODAY });
    const merged = mergeReviewRows([...first, ...scrolled]);
    expect(merged).toHaveLength(2);
    expect(merged.find((r) => r.amountMinor === 18_000_000)?.images).toEqual([0, 1]);
  });
});

describe('a Techcombank row and a VietinBank row are never confused', () => {
  it('separates two transfers that differ only in which bank sent them', () => {
    // Same amount, same day, same minute, same payee - the worst case for any
    // scheme that keys on the visible figures alone.
    const viettin = rowKey({
      txnDate: '2026-11-09',
      time: '14:32',
      direction: 'outflow',
      amountMinor: 2_500_000,
      reference: 'VTB-0001',
      counterpartyAccount: '0071001234567',
      counterpartyName: 'NGUYEN VAN AN',
      description: 'AHN thanh toan thiet ke',
    });
    const techcom = rowKey({
      txnDate: '2026-11-09',
      time: '14:32',
      direction: 'outflow',
      amountMinor: 2_500_000,
      reference: 'FT26314090112233',
      counterpartyAccount: '0071001234567',
      counterpartyName: 'NGUYEN VAN AN',
      description: 'AHN thanh toan thiet ke',
    });
    expect(viettin).not.toBe(techcom);
  });
});
