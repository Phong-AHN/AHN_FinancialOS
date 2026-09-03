import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Proving a request really came from Slack - Spec section 25.
 *
 * This endpoint answers questions about the company's money. Anyone who learns
 * the URL can POST to it, and Slack's own payload is just form fields: a
 * `user_id` in the body proves nothing, because the sender wrote it.
 *
 * So every request is verified against the signing secret before a single row
 * is read. Slack signs the string `v0:{timestamp}:{raw body}` with HMAC-SHA256,
 * and the raw body must be the bytes as sent - re-serialising parsed form data
 * changes the ordering and encoding, and the signature stops matching for
 * reasons that look like a Slack bug for a whole afternoon.
 */

/**
 * How old a signed request may be.
 *
 * Slack recommends five minutes. A valid signature is replayable forever
 * without this: an attacker who captures one `/ahn cash` request off a proxy
 * log can send it back any time and get today's numbers, which is a slow but
 * genuine leak of a live figure.
 */
export const MAX_REQUEST_AGE_SECONDS = 300;

export type VerifyFailure =
  | 'not-configured'
  | 'missing-headers'
  | 'stale-timestamp'
  | 'bad-signature';

export interface VerifyResult {
  ok: boolean;
  failure?: VerifyFailure;
}

export const VERIFY_MESSAGES: Record<VerifyFailure, string> = {
  'not-configured': 'SLACK_SIGNING_SECRET is not set, so slash commands are disabled.',
  'missing-headers': 'Missing Slack signature headers.',
  'stale-timestamp': 'Request timestamp is outside the accepted window.',
  'bad-signature': 'Signature did not match.',
};

/**
 * Verify one Slack request.
 *
 * With no signing secret configured this returns `not-configured` rather than
 * passing. An endpoint that answers financial questions must refuse to run
 * before it will run unauthenticated - the same stance `authorizeCron` takes.
 */
export function verifySlackRequest(
  rawBody: string,
  headers: { signature: string | null; timestamp: string | null },
  opts: { signingSecret?: string | undefined; now?: Date } = {},
): VerifyResult {
  const secret = opts.signingSecret ?? process.env.SLACK_SIGNING_SECRET;
  if (!secret) return { ok: false, failure: 'not-configured' };

  const { signature, timestamp } = headers;
  if (!signature || !timestamp) return { ok: false, failure: 'missing-headers' };

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return { ok: false, failure: 'missing-headers' };

  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  // Absolute difference, so a timestamp from the future is refused too: a clock
  // skewed forwards would otherwise widen the replay window indefinitely.
  if (Math.abs(nowSeconds - sent) > MAX_REQUEST_AGE_SECONDS) {
    return { ok: false, failure: 'stale-timestamp' };
  }

  const expected =
    'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex');

  if (!constantTimeEqual(expected, signature)) return { ok: false, failure: 'bad-signature' };
  return { ok: true };
}

/**
 * Compare without leaking where two strings diverge.
 *
 * `timingSafeEqual` throws on a length mismatch, and catching that would leak
 * the length by how fast it answered. Both sides are hashed to a fixed 32 bytes
 * first, so every comparison costs the same regardless of the input.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHmac('sha256', 'compare').update(a).digest();
  const hb = createHmac('sha256', 'compare').update(b).digest();
  return timingSafeEqual(ha, hb);
}
