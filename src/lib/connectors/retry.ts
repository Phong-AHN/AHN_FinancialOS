/**
 * Retrying a failed provider call, and knowing when not to.
 *
 * Intuit asks two things of an app that holds OAuth tokens: that it retries
 * requests which failed for a transient reason, and that it asks the customer
 * to reconnect when they failed for a permanent one. Those are opposite
 * responses, so the whole problem is telling the two apart.
 *
 * BEFORE THIS, EVERY FAILURE WAS THE SAME FAILURE. `syncQuickBooks` caught
 * anything that went wrong, wrote `status: 'error'` with the message, and moved
 * on. A one-second network blip and a permanently revoked refresh token looked
 * identical on the Integrations page, and neither was retried. The blip meant
 * ten minutes of missing data for no reason; the revoked token meant the sync
 * silently failed every ten minutes, forever, until somebody happened to look.
 *
 * FIVE OUTCOMES, NOT TWO:
 *
 *   transient      — retry with backoff. Network, 429, 5xx.
 *   reconnect      — the grant is gone. Retrying is pointless and rude; the
 *                    customer has to authorise again.
 *   configuration  — our own keys or setup are wrong. Retrying is pointless
 *                    and reconnecting will not help either, because the next
 *                    connect attempt fails the same way.
 *   unavailable    — nothing is wrong at all: this customer's QuickBooks
 *                    subscription simply does not include the feature. Simple
 *                    Start has no bills, so asking it for Bill is refused with
 *                    code 5030. Not retried, not reported as a fault — the
 *                    entity is skipped and asked for again later, because the
 *                    customer can upgrade at any time.
 *
 *   rejected       — Intuit refused the request itself as malformed: a query
 *                    that does not parse (code 4000) or names a field that
 *                    does not exist (4001). That is a bug in THIS code, and it
 *                    fails identically every time. Retrying it sends Intuit a
 *                    request we already know is broken, three times a call.
 *
 * Collapsing `reconnect` and `configuration` would be the tempting simplification and it produces
 * the worst possible instruction: telling somebody to reconnect when the reason
 * it broke is that `QBO_CLIENT_SECRET` is wrong. They would reconnect, watch it
 * fail, and have learned nothing.
 */

export type FailureKind = 'transient' | 'reconnect' | 'configuration' | 'unavailable' | 'rejected';

/** A provider call that failed, carrying what should be done about it. */
export class ProviderAuthError extends Error {
  readonly kind: FailureKind;
  readonly status: number | null;
  readonly provider: string;
  /** What to show a person. Never contains a token or a secret. */
  readonly advice: string;
  /**
   * Intuit's `intuit_tid` response header — the id their support team looks a
   * request up by. Without it, "the sync failed on Tuesday" is a conversation;
   * with it, it is a lookup.
   */
  readonly tid: string | null;
  /** Intuit's own error code from `Fault.Error[0].code` — 4000, 4001, 5030… */
  readonly faultCode: string | null;

  constructor(options: {
    provider: string;
    kind: FailureKind;
    status: number | null;
    message: string;
    advice: string;
    tid?: string | null;
    faultCode?: string | null;
  }) {
    super(options.message);
    this.name = 'ProviderAuthError';
    this.provider = options.provider;
    this.kind = options.kind;
    this.status = options.status;
    this.advice = options.advice;
    this.tid = options.tid ?? null;
    this.faultCode = options.faultCode ?? null;
  }

  get needsReconnect(): boolean {
    return this.kind === 'reconnect';
  }
}

/**
 * Classify an Intuit response.
 *
 * The status code alone is not enough: Intuit answers **400** both for
 * `invalid_grant` (the refresh token is dead — reconnect) and for
 * `invalid_client` (our client id or secret is wrong — reconnecting changes
 * nothing). The body is what separates them, so the body is what is read.
 */
/** `Fault.Error[0]` from an Intuit error body, if there is one. */
export function parseIntuitFault(body: string): {
  type: string | null;
  code: string | null;
  message: string | null;
  detail: string | null;
} {
  try {
    const json = JSON.parse(body) as {
      Fault?: { type?: string; Error?: Array<{ code?: string; Message?: string; Detail?: string }> };
    };
    const first = json.Fault?.Error?.[0];
    return {
      type: json.Fault?.type ?? null,
      code: first?.code ?? null,
      message: first?.Message ?? null,
      detail: first?.Detail ?? null,
    };
  } catch {
    return { type: null, code: null, message: null, detail: null };
  }
}

export function classifyIntuitFailure(
  status: number,
  body: string,
  tid: string | null = null,
): ProviderAuthError {
  const classified = classify(status, body);
  const fault = parseIntuitFault(body);
  return new ProviderAuthError({
    provider: classified.provider,
    kind: classified.kind,
    status: classified.status,
    // The tid rides on the message too, because the message is what reaches
    // logs and `last_error`, and a log line without it cannot be looked up.
    message: tid ? `${classified.message} [intuit_tid ${tid}]` : classified.message,
    advice: classified.advice,
    tid,
    faultCode: fault.code,
  });
}

function classify(status: number, body: string): ProviderAuthError {
  const text = body.toLowerCase();

  // The refresh token is gone: revoked from inside QuickBooks, already used
  // (Intuit rotates on every refresh), or expired after 100 days unused.
  // Nothing this application can do fixes it.
  if (text.includes('invalid_grant')) {
    return new ProviderAuthError({
      provider: 'quickbooks',
      kind: 'reconnect',
      status,
      // `invalid_grant` answers BOTH exchanges: a refresh token that is dead,
      // and an authorisation code that expired or was already used — which is
      // what reloading the callback page after a connect produces. The
      // message names neither, so it is true for both.
      message: `QuickBooks refused the authorisation (${status}): invalid_grant — expired, already used, or revoked`,
      advice:
        'The QuickBooks connection has expired or was disconnected. Reconnect it to resume syncing.',
    });
  }

  // Our own credentials. A person reconnecting cannot fix this and should not
  // be asked to try.
  if (text.includes('invalid_client') || text.includes('unauthorized_client')) {
    return new ProviderAuthError({
      provider: 'quickbooks',
      kind: 'configuration',
      status,
      message: `QuickBooks rejected the client credentials (${status}): invalid_client`,
      advice:
        'QBO_CLIENT_ID or QBO_CLIENT_SECRET is wrong, or belongs to the other Intuit environment. Reconnecting will not fix this.',
    });
  }

  // The customer's subscription does not include this feature — Simple Start
  // asked for a Bill, for example. Intuit's code is 5030, "Feature Not
  // Supported". Checked on the body rather than the status, because the thing
  // that matters is the code: treating this as transient would retry it three
  // times on every tick, and treating it as a fault would fail the whole sync
  // over data the customer does not have.
  if (/"code"\s*:\s*"5030"|feature not supported|not included in your quickbooks/i.test(body)) {
    return new ProviderAuthError({
      provider: 'quickbooks',
      kind: 'unavailable',
      status,
      message: `This QuickBooks subscription does not include the requested feature (${status}, 5030)`,
      advice:
        'This QuickBooks subscription does not include this feature. It is skipped, and checked again in case the subscription changes.',
    });
  }

  // Rate limiting and Intuit's own outages. Both pass.
  if (status === 429 || status >= 500) {
    return new ProviderAuthError({
      provider: 'quickbooks',
      kind: 'transient',
      status,
      message: `QuickBooks is temporarily unavailable (${status})`,
      advice: 'Intuit was unavailable or rate-limiting. The next sync will try again.',
    });
  }

  // A 401 is classified as a dead grant, but `createQboSession` intercepts the
  // first one and retries with a force-refreshed token (decision 105). Only a
  // 401 that survives a brand-new token ever reaches a person as "reconnect".
  if (status === 401) {
    return new ProviderAuthError({
      provider: 'quickbooks',
      kind: 'reconnect',
      status,
      message: `QuickBooks refused a valid-looking token (${status})`,
      advice:
        'QuickBooks rejected the access token. The connection needs to be authorised again.',
    });
  }

  if (status === 403) {
    return new ProviderAuthError({
      provider: 'quickbooks',
      kind: 'configuration',
      status,
      message: `QuickBooks refused the request (${status})`,
      advice:
        'The connected app does not have permission for this data. Check the scopes on the Intuit app.',
    });
  }

  // Every other 4xx is Intuit saying the REQUEST is wrong — a query that does
  // not parse (4000), a field or entity that does not exist (4001), a value of
  // the wrong type. Measured against the live API: all four come back 400 with
  // `Fault.type: "ValidationFault"`.
  //
  // This used to fall through to "transient" and be retried three times. A
  // malformed query is malformed every time, so that was three identical bad
  // requests per call, per ten-minute tick — the pattern Intuit's review asks
  // about. It is a bug here, so it is reported as one, with the detail Intuit
  // gave, and never retried.
  if (status >= 400 && status < 500) {
    const fault = parseIntuitFault(body);
    const what = [fault.message, fault.detail].filter(Boolean).join(' — ') || body.slice(0, 200);
    return new ProviderAuthError({
      provider: 'quickbooks',
      kind: 'rejected',
      status,
      message: `QuickBooks rejected the request (${status}${fault.code ? `, code ${fault.code}` : ''}): ${what.slice(0, 300)}`,
      advice:
        'QuickBooks rejected a request this application made as invalid. This is a fault in the application, not in your QuickBooks company — report it with the intuit_tid shown.',
    });
  }

  // Nothing recognisable at all — not an HTTP error class we know. One trip
  // through the retry budget, then it surfaces.
  return new ProviderAuthError({
    provider: 'quickbooks',
    kind: 'transient',
    status,
    message: `QuickBooks request failed (${status}): ${body.slice(0, 200)}`,
    advice: 'The request failed. The next sync will try again.',
  });
}

export interface RetryOptions {
  /** Total attempts including the first. Intuit rate-limits; keep it small. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Called before each wait, for logging. */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
  /** Injectable so tests do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `task`, retrying only what is worth retrying.
 *
 * FULL JITTER, not a fixed doubling. Every integration in this system is woken
 * by the same ten-minute scheduler tick, so a fixed backoff means each one
 * retries at the same instant as the others — the pattern that turns one
 * provider hiccup into a self-inflicted burst against a rate limit. Sleeping a
 * random interval up to the exponential bound spreads them out.
 *
 * The retry budget is three attempts. It is deliberately small: this runs every
 * ten minutes anyway, so a genuine outage is retried 144 times a day by the
 * scheduler without any help from here. Retrying hard inside a single tick buys
 * nothing and looks, from Intuit's side, exactly like an app with a bug.
 */
export async function withRetry<T>(
  task: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastError = err;

      // Only transient failures are worth another go. A `reconnect` or
      // `configuration` error is rethrown immediately — hammering Intuit's
      // token endpoint with a refresh token it has already told us is dead is
      // precisely the behaviour they ask apps not to have.
      if (err instanceof ProviderAuthError && err.kind !== 'transient') throw err;

      if (attempt === attempts) break;

      const bound = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = Math.round(Math.random() * bound);
      options.onRetry?.({
        attempt,
        delayMs,
        reason: err instanceof Error ? err.message : String(err),
      });
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * A thrown fetch — DNS failure, connection reset, timeout — as a transient
 * error, so the caller does not have to tell network faults from HTTP ones.
 */
export function asTransient(provider: string, err: unknown): ProviderAuthError {
  return new ProviderAuthError({
    provider,
    kind: 'transient',
    status: null,
    message: err instanceof Error ? err.message : String(err),
    advice: 'Could not reach the provider. The next sync will try again.',
  });
}
