import { describe, expect, it, vi } from 'vitest';
import {
  ProviderAuthError,
  asTransient,
  classifyIntuitFailure,
  withRetry,
} from '@/lib/connectors/retry';

/**
 * Retrying what is worth retrying, and refusing to retry what is not.
 *
 * Both halves matter and they fail in opposite directions. Not retrying a
 * transient fault loses ten minutes of data for no reason. Retrying a permanent
 * one hammers Intuit's token endpoint with a refresh token they have already
 * said is dead — the behaviour their review asks about, and the reason the
 * question is on the form.
 */

const never = async () => {
  throw new Error('should not have been called');
};

describe('classifyIntuitFailure', () => {
  it('reads the body, because 400 means two opposite things', () => {
    // THE WHOLE REASON THIS FUNCTION EXISTS. Intuit answers 400 both for a dead
    // refresh token and for wrong client credentials. On the status code alone
    // these are identical, and the right response to each is the opposite of
    // the other: ask the customer to reconnect, or do not.
    const grant = classifyIntuitFailure(400, '{"error":"invalid_grant"}');
    const client = classifyIntuitFailure(400, '{"error":"invalid_client"}');

    expect(grant.kind).toBe('reconnect');
    expect(client.kind).toBe('configuration');
    expect(grant.status).toBe(client.status);
  });

  it('never tells somebody to reconnect over our own bad credentials', () => {
    // Reconnecting cannot fix QBO_CLIENT_SECRET. Telling them to try means they
    // authorise, watch it fail, and have learned nothing.
    const err = classifyIntuitFailure(401, 'invalid_client');
    expect(err.needsReconnect).toBe(false);
    expect(err.advice).toMatch(/QBO_CLIENT_ID|QBO_CLIENT_SECRET/);
    expect(err.advice).toMatch(/will not fix/i);
  });

  it('treats rate limiting and outages as transient', () => {
    for (const status of [429, 500, 502, 503]) {
      expect(classifyIntuitFailure(status, '').kind, `status ${status}`).toBe('transient');
    }
  });

  it('treats a 401 on the company API as a dead grant', () => {
    // getAccessToken has already ensured the token is fresh, so a 401 here is
    // not staleness — it is the grant being gone.
    const err = classifyIntuitFailure(401, 'AuthenticationFailed');
    expect(err.kind).toBe('reconnect');
  });

  // The next three bodies are verbatim from the live sandbox
  // (tests/qbo-errors.integration.test.ts), not invented.
  const SYNTAX_ERROR =
    '{"Fault":{"Error":[{"Message":"Error parsing query","Detail":"QueryParserError: Encountered \\" <IDENTIFIER> \\"TxnDate \\"\\" at line 1, column 29.","code":"4000"}],"type":"ValidationFault"}}';
  const VALIDATION_ERROR =
    '{"Fault":{"Error":[{"Message":"Invalid query","Detail":"QueryValidationError: Property NoSuchField not found for Entity Purchase","code":"4001"}],"type":"ValidationFault"}}';

  it('treats a query that does not parse as rejected — our bug, never retried', () => {
    // THIS USED TO BE "transient". A malformed query fails identically every
    // time, so it was three identical bad requests per call, every tick.
    const err = classifyIntuitFailure(400, SYNTAX_ERROR, '1-6aa36f3e-7c887528297dc3cd2d23dbe2');
    expect(err.kind).toBe('rejected');
    expect(err.faultCode).toBe('4000');
    expect(err.message).toMatch(/Error parsing query/);
    expect(err.needsReconnect).toBe(false);
  });

  it('treats a validation error as rejected, with Intuit’s detail kept', () => {
    const err = classifyIntuitFailure(400, VALIDATION_ERROR);
    expect(err.kind).toBe('rejected');
    expect(err.faultCode).toBe('4001');
    expect(err.message).toMatch(/Property NoSuchField not found/);
  });

  it('treats any other 4xx as rejected too — a client error is not a blip', () => {
    expect(classifyIntuitFailure(404, 'not found').kind).toBe('rejected');
    expect(classifyIntuitFailure(422, '').kind).toBe('rejected');
  });

  it('carries the intuit_tid on the error and in the message', () => {
    // The message is what reaches logs and `last_error`. A log line without
    // the tid is one Intuit's support cannot look up.
    const err = classifyIntuitFailure(503, '', '1-abc-def');
    expect(err.tid).toBe('1-abc-def');
    expect(err.message).toContain('[intuit_tid 1-abc-def]');
  });

  it('still classifies correctly when there is no tid', () => {
    const err = classifyIntuitFailure(400, 'invalid_grant');
    expect(err.tid).toBeNull();
    expect(err.message).not.toContain('intuit_tid');
  });

  it('never retries a rejected request', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw classifyIntuitFailure(400, SYNTAX_ERROR);
        },
        { sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ kind: 'rejected' });
    expect(calls, 'a malformed query was sent again').toBe(1);
  });

  it('carries no token or secret in the message', () => {
    const err = classifyIntuitFailure(400, '{"error":"invalid_grant","token":"SECRET-abc123"}');
    // The body is not echoed for a classified failure — only for the unknown
    // case, where there is nothing else to report.
    expect(err.message).not.toContain('SECRET-abc123');
    expect(err.advice).not.toContain('SECRET-abc123');
  });
});

describe('withRetry', () => {
  const sleep = async () => {};

  it('retries a transient failure and returns the eventual success', async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw asTransient('quickbooks', new Error('ECONNRESET'));
        return 'ok';
      },
      { sleep },
    );
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does NOT retry a dead refresh token', async () => {
    // The behaviour Intuit's review is asking about.
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw classifyIntuitFailure(400, 'invalid_grant');
        },
        { sleep },
      ),
    ).rejects.toBeInstanceOf(ProviderAuthError);
    expect(calls, 'a revoked grant was retried').toBe(1);
  });

  it('does NOT retry a configuration failure', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw classifyIntuitFailure(400, 'invalid_client');
        },
        { sleep },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('gives up after the budget and rethrows the last failure', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw asTransient('quickbooks', new Error('still down'));
        },
        { attempts: 3, sleep },
      ),
    ).rejects.toThrow(/still down/);
    expect(calls).toBe(3);
  });

  it('defaults to a small budget — three attempts, not more', async () => {
    // The scheduler already retries every ten minutes, 144 times a day. Trying
    // hard inside a single tick buys nothing against a real outage and looks,
    // from Intuit's side, exactly like an app with a runaway loop. Measured by
    // counting calls with no `attempts` passed, so the default cannot drift.
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw asTransient('quickbooks', new Error('down'));
        },
        { sleep },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it('jitters the delay instead of retrying in lockstep', async () => {
    // Every integration is woken by the same ten-minute tick. A fixed backoff
    // means they all retry at the same instant — one provider hiccup becoming a
    // self-inflicted burst against a rate limit.
    const delays: number[] = [];
    const spy = vi.spyOn(Math, 'random');
    spy.mockReturnValueOnce(0.1).mockReturnValueOnce(0.9);

    await withRetry(
      async () => {
        if (delays.length < 2) throw asTransient('x', new Error('blip'));
        return 'done';
      },
      {
        baseDelayMs: 1000,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    spy.mockRestore();
    expect(delays).toHaveLength(2);
    expect(delays[0]).not.toBe(delays[1]);
  });

  it('succeeds without sleeping when the first attempt works', async () => {
    const sleepSpy = vi.fn(async () => {});
    const out = await withRetry(async () => 'first', { sleep: sleepSpy });
    expect(out).toBe('first');
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('passes a non-provider error straight through the budget', async () => {
    // A bug in our own code is not a provider fault, but it is also not
    // something to classify as permanent. It burns the budget and surfaces.
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new TypeError('undefined is not a function');
        },
        { attempts: 2, sleep },
      ),
    ).rejects.toThrow(TypeError);
    expect(calls).toBe(2);
  });
});

describe('asTransient', () => {
  it('turns a thrown fetch into something retryable', async () => {
    // DNS, connection reset, timeout — never a reason to tell somebody to
    // reconnect.
    const err = asTransient('quickbooks', new Error('fetch failed'));
    expect(err.kind).toBe('transient');
    expect(err.needsReconnect).toBe(false);
    expect(err.status).toBeNull();
  });
});
