/**
 * Security primitives - Spec section 25 (least privilege, defence in depth).
 *
 * Three things live here, each written because an audit of this codebase found
 * the gap rather than because a checklist named it.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// ─── Redirect targets ───────────────────────────────────────────────────────

/**
 * Make a `?next=` parameter safe to redirect to.
 *
 * THE BUG THIS FIXES. The sign-in callback did `redirect(`${origin}${next}`)`
 * with `next` straight from the query string. `?next=//evil.com` produces
 * `https://ourapp.com//evil.com`, which every browser reads as a
 * protocol-relative URL and follows to `evil.com`.
 *
 * That is not a theoretical grade of bad here. The victim clicks a sign-in link,
 * authenticates successfully against the real application, and is then handed
 * to a page that can look exactly like it and ask them to sign in again. In a
 * system holding a company's bank connections, an attacker-chosen landing page
 * after a genuine login is a phishing primitive.
 *
 * Rules, in the order they matter:
 *   - must start with a single `/`  (rejects `https://evil.com`)
 *   - must NOT start with `//` or `/\`  (rejects protocol-relative forms)
 *   - must contain no control characters  (rejects `/\nLocation: ...` splitting)
 *
 * Anything else falls back to `/`. A person who ends up on the dashboard
 * instead of their intended page has lost nothing; a person who ends up on an
 * attacker's page has lost everything.
 */
export function safeNextPath(raw: string | null | undefined, fallback = '/'): string {
  if (!raw) return fallback;

  const value = raw.trim();
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;
  // Backslashes are normalised to forward slashes by some browsers, so `/\/`
  // and its relatives have to go too.
  if (value.includes('\\')) return fallback;
  // Header-splitting and smuggling attempts: a newline in a Location value
  // is how one redirect becomes two responses.
  if (hasControlCharacter(value)) return fallback;

  return value;
}

/**
 * True when the string holds a C0 control character or DEL.
 *
 * Written as a code-point scan rather than a regex on purpose: the escape
 * sequences a regex needs for this range are exactly the ones that get eaten
 * by a shell or an editor and turn into REAL control characters in the source,
 * at which point the check silently stops matching what it was written to match.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

// ─── Cross-site request forgery ─────────────────────────────────────────────

/**
 * Refuse a state-changing request that did not come from our own pages.
 *
 * The session lives in a cookie, so a form on another site could otherwise
 * cause the browser to POST here with the reader's credentials attached.
 * SameSite=Lax blocks most of that on its own, but it is one browser default
 * away from not applying, and every route behind this check moves money data:
 * re-categorising transactions, attributing them to projects, changing alert
 * thresholds, setting an exchange rate that revalues the whole ledger.
 *
 * Checked against `Origin` first, falling back to `Referer`, because some
 * clients omit `Origin` on same-origin requests. A request carrying neither is
 * allowed only when it is not from a browser at all - server-to-server calls
 * and the test harness send no `Sec-Fetch-Site`.
 */
export function crossOriginRefusal(request: Request): Response | null {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;

  // Browsers that send this header make the decision trivial and correct.
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'same-origin' || fetchSite === 'none') return null;
  if (fetchSite && fetchSite !== 'same-origin') {
    return refuse(`cross-site request (Sec-Fetch-Site: ${fetchSite})`);
  }

  const target = new URL(request.url).host;
  const stated = request.headers.get('origin') ?? request.headers.get('referer');

  // No Origin, no Referer and no Sec-Fetch-Site is not a browser form post.
  if (!stated) return null;

  let statedHost: string;
  try {
    statedHost = new URL(stated).host;
  } catch {
    return refuse('unparseable Origin or Referer');
  }

  return statedHost === target ? null : refuse(`Origin ${statedHost} does not match ${target}`);
}

function refuse(reason: string): Response {
  return Response.json(
    { ok: false, error: `Refused: ${reason}. State-changing requests must come from this site.` },
    { status: 403 },
  );
}

// ─── Rate limiting ──────────────────────────────────────────────────────────

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimit {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/**
 * A fixed-window limiter held in process memory.
 *
 * HONEST ABOUT WHAT THIS IS. Memory is per-instance, so two server instances
 * allow twice the limit, and a restart forgets everything. It is not a defence
 * against a distributed attacker.
 *
 * What it does defend against is the realistic failure here: a loop, a stuck
 * retry or one impatient person hammering a route that calls a bank API, sends
 * Slack messages, or re-reads three years of ledger. Those cost money and
 * credibility with the upstream provider, and they come from one source.
 *
 * A shared limiter (Upstash, or Postgres) is the upgrade when this runs on more
 * than one instance - noted in SECURITY.md rather than pretended away.
 */
export function rateLimitRefusal(key: string, config: RateLimit): Response | null {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + config.windowMs });
    sweep(now);
    return null;
  }

  bucket.count += 1;
  if (bucket.count <= config.limit) return null;

  const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  return Response.json(
    { ok: false, error: `Too many requests. Try again in ${retryAfter}s.` },
    { status: 429, headers: { 'retry-after': String(retryAfter) } },
  );
}

/** Keeps the map from growing without bound on a long-lived process. */
function sweep(now: number): void {
  if (buckets.size < 500) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/** Identifies the caller for rate-limiting purposes. */
export function callerKey(request: Request, scope: string): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
  return `${scope}:${ip}`;
}

// ─── Constant-time comparison ───────────────────────────────────────────────

/**
 * Compare two secrets without leaking their contents OR their length.
 *
 * The previous implementation returned early on a length mismatch, which tells
 * an attacker how long the secret is - one of the two things they need. HMAC-ing
 * both sides first makes every comparison the same fixed width, so the length
 * of the input reveals nothing about the length of the secret.
 *
 * The HMAC key is per-process and random: it never leaves memory and only has
 * to make the two digests comparable, not secret.
 */
const COMPARE_KEY = randomBytes(32);

export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHmac('sha256', COMPARE_KEY).update(a, 'utf8').digest();
  const digestB = createHmac('sha256', COMPARE_KEY).update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}
