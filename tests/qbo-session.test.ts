import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQboSession } from '@/lib/connectors/quickbooks';
import { classifyIntuitFailure } from '@/lib/connectors/retry';
import { encryptSecret } from '@/lib/crypto';
import type { Integration } from '@/lib/types';

/**
 * Surviving an access token that died before its stated expiry.
 *
 * `getAccessToken` decides whether to refresh from the expiry we stored when
 * the token was issued. That is right almost always and blind to the case where
 * Intuit invalidates a token early — our clock says forty minutes left, their
 * answer is 401.
 *
 * Before `createQboSession`, that 401 was reported as "please reconnect": a
 * manual OAuth round trip demanded of somebody whose refresh token was valid
 * and one call away from fixing it.
 */

// A valid key: `crypto.ts` decodes it as BASE64 and requires 32 bytes. This
// used to be `'a'.repeat(64)` — 48 bytes as base64 — and nobody noticed,
// because on a machine with `.env.local` the real key was always set first.
// The first run without it (CI) failed all six tests below.
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.QBO_CLIENT_ID ??= 'test-client';
process.env.QBO_CLIENT_SECRET ??= 'test-secret';

function integrationWith(expiresAt: string): Integration {
  return {
    id: 'int-1',
    provider: 'quickbooks',
    label: 'test',
    status: 'connected',
    external_id: 'realm-1',
    access_token_enc: encryptSecret('access-token-1'),
    refresh_token_enc: encryptSecret('refresh-token-1'),
    token_expires_at: expiresAt,
    last_synced_at: null,
    last_cursor: null,
    last_error: null,
    metadata: {},
    created_at: new Date().toISOString(),
  } as Integration;
}

/** An hour of life left, so nothing refreshes unless it is forced to. */
const healthyLooking = () => integrationWith(new Date(Date.now() + 3_600_000).toISOString());

function stubTokenEndpoint(refreshTokens: string[]) {
  let issued = 0;
  const seen: string[] = [];
  const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
    const body = new URLSearchParams(String(init.body));
    seen.push(body.get('refresh_token') ?? '');
    const next = refreshTokens[issued] ?? `rotated-${issued}`;
    issued++;
    return new Response(
      JSON.stringify({
        access_token: `fresh-access-${issued}`,
        refresh_token: next,
        expires_in: 3600,
        token_type: 'bearer',
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal('fetch', fetchSpy);
  return { seen, get issued() { return issued; } };
}

afterEach(() => vi.unstubAllGlobals());

describe('createQboSession', () => {
  it('uses the cached token when nothing goes wrong', async () => {
    const persist = vi.fn(async () => {});
    const tokens = stubTokenEndpoint([]);
    const session = createQboSession(healthyLooking(), persist);

    const seenBy = await session.run(async (token) => token);

    expect(seenBy).toBe('access-token-1');
    expect(tokens.issued, 'refreshed when it did not need to').toBe(0);
    expect(persist).not.toHaveBeenCalled();
  });

  it('forces a refresh and retries once when Intuit answers 401', async () => {
    // The whole point. The stored expiry said the token was good.
    const persist = vi.fn(async () => {});
    stubTokenEndpoint(['refresh-token-2']);
    const session = createQboSession(healthyLooking(), persist);

    const tokensPresented: string[] = [];
    const out = await session.run(async (token) => {
      tokensPresented.push(token);
      if (tokensPresented.length === 1) throw classifyIntuitFailure(401, 'AuthenticationFailed');
      return 'worked on the second try';
    });

    expect(out).toBe('worked on the second try');
    expect(tokensPresented).toEqual(['access-token-1', 'fresh-access-1']);
    expect(persist, 'the rotated token was not written to the database').toHaveBeenCalledTimes(1);
  });

  it('presents the ROTATED refresh token, never the retired one', async () => {
    // THE TRAP. Intuit issues a new refresh token on every refresh and
    // invalidates the old one. `Integration` is a snapshot, so a second refresh
    // that re-read it would present a token Intuit has already retired, get
    // invalid_grant, and report "reconnect" for a healthy connection.
    const persist = vi.fn(async () => {});
    // Start expired, so the session refreshes once up front, then 401 to force
    // a second refresh — the moment the stale snapshot would be reused.
    const tokens = stubTokenEndpoint(['refresh-token-2', 'refresh-token-3']);
    const session = createQboSession(
      integrationWith(new Date(Date.now() - 1000).toISOString()),
      persist,
    );

    let calls = 0;
    await session.run(async (token) => {
      calls++;
      if (calls === 1) throw classifyIntuitFailure(401, 'AuthenticationFailed');
      return token;
    });

    expect(tokens.seen).toEqual(['refresh-token-1', 'refresh-token-2']);
    expect(tokens.seen[1], 'the retired refresh token was presented again').not.toBe(
      'refresh-token-1',
    );
  });

  it('gives up after one retry — a 401 with a brand new token is a dead grant', async () => {
    const persist = vi.fn(async () => {});
    stubTokenEndpoint(['refresh-token-2']);
    const session = createQboSession(healthyLooking(), persist);

    let calls = 0;
    await expect(
      session.run(async () => {
        calls++;
        throw classifyIntuitFailure(401, 'AuthenticationFailed');
      }),
    ).rejects.toMatchObject({ kind: 'reconnect' });

    // Exactly twice: the original and one retry. Looping here would hammer
    // Intuit's token endpoint on every ten-minute tick.
    expect(calls).toBe(2);
  });

  it('does not retry a 403 — a scope problem is not a stale token', async () => {
    const persist = vi.fn(async () => {});
    const tokens = stubTokenEndpoint([]);
    const session = createQboSession(healthyLooking(), persist);

    let calls = 0;
    await expect(
      session.run(async () => {
        calls++;
        throw classifyIntuitFailure(403, 'Forbidden');
      }),
    ).rejects.toMatchObject({ kind: 'configuration' });

    expect(calls).toBe(1);
    expect(tokens.issued, 'refreshed over a permissions error').toBe(0);
  });

  it('passes a non-auth failure straight through', async () => {
    const persist = vi.fn(async () => {});
    const session = createQboSession(healthyLooking(), persist);

    await expect(
      session.run(async () => {
        throw new TypeError('a bug in our own mapping code');
      }),
    ).rejects.toThrow(TypeError);
  });
});
