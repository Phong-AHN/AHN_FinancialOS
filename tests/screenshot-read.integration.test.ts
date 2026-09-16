import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { readScreenshot, sniffImageType } from '@/lib/image-import/read-screenshot';
import { importable, reviewScreenshot } from '@/lib/image-import/review';

/**
 * The real model, reading the real sample screenshot.
 *
 * Everything else about screenshot import is tested without a model: the
 * checks in review.ts against a hand transcription of this screenshot, and the
 * routes at runtime. This is the one test that asks whether Claude actually
 * reads a VietinBank transfer list the way the hand transcription does — the
 * amounts to the dong, the cut-off card's missing number left missing.
 *
 * Save the screenshot AHN supplied (VietinBank → Yêu cầu của tôi → Đã duyệt →
 * Chuyển tiền, showing HAI MINH 6,500,000 and Q.P.T 9,396,000) and point at it:
 *
 *   SCREENSHOT_TEST=1 SCREENSHOT_SAMPLE=./vietinbank-sample.png \
 *     npx vitest run tests/screenshot-read.integration.test.ts
 *
 * One paid request per run.
 */
const sample = process.env.SCREENSHOT_SAMPLE;
const ENABLED =
  process.env.SCREENSHOT_TEST === '1' &&
  Boolean(process.env.ANTHROPIC_API_KEY && sample && fs.existsSync(sample));

describe.skipIf(!ENABLED)('Claude reading the sample VietinBank screenshot', () => {
  it('reads both visible transfers exactly', async () => {
    const data = new Uint8Array(fs.readFileSync(sample!));
    const mediaType = sniffImageType(data);
    expect(mediaType, 'the sample is not a PNG/JPEG/WebP').not.toBeNull();

    const { reading, model } = await readScreenshot({ data, mediaType: mediaType! });
    const rows = reviewScreenshot(reading, 0, { today: new Date().toISOString().slice(0, 10) });
    console.log(`\n  ${model} read ${rows.length} rows from "${reading.screen_title} / ${reading.tab}":`);
    for (const r of rows) {
      console.log(
        `    ${r.txnDate} ${r.time}  ${r.direction === 'outflow' ? '−' : '+'}${r.amountMinor}  ` +
          `${r.counterpartyName}  #${r.reference ?? '—'}  ${r.statusText}  [${r.issues.join(', ') || 'ok'}]`,
      );
    }

    expect(reading.is_transaction_list).toBe(true);
    expect(reading.shows_posted_transactions).toBe(false);

    const qpt = rows.find((r) => r.amountMinor === 9_396_000);
    expect(qpt, '9,396,000 to Q.P.T was not read').toBeTruthy();
    expect(qpt).toMatchObject({
      direction: 'outflow',
      txnDate: '2026-08-25',
      time: '11:30:21',
      reference: '1031926H25810864',
      counterpartyAccount: '0181003502766',
      statusText: 'Thành công',
    });
    expect(importable(qpt!)).toBe(true);

    const haiMinh = rows.find((r) => r.amountMinor === 6_500_000);
    expect(haiMinh, '6,500,000 to HAI MINH was not read').toBeTruthy();
    expect(haiMinh).toMatchObject({
      direction: 'outflow',
      txnDate: '2026-08-30',
      time: '16:29:12',
      counterpartyAccount: '8551100116001',
    });
    // Its transaction number is above the top edge. Borrowing Q.P.T's — the
    // number printed just below it — is the specific misreading the prompt
    // warns against.
    expect(haiMinh!.reference).not.toBe('1031926H25810864');
    expect(importable(haiMinh!)).toBe(true);
  }, 90_000);
});
