import { beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createQboSession, fetchQboAccounts } from '@/lib/connectors/quickbooks';
import { encryptSecret } from '@/lib/crypto';
import type { Integration } from '@/lib/types';

/**
 * An access token that dies before its stated expiry, against the real Intuit.
 *
 * THE CASE NO STORED EXPIRY CAN SEE. `getAccessToken` refreshes based on the
 * expiry recorded when the token was issued. Intuit can invalidate an access
 * token earlier than that — a password change, a security event on the Intuit
 * account, our timestamp drifting. Our clock says the token is good; Intuit
 * answers 401.
 *
 * The unit tests in `qbo-session.test.ts` prove the retry logic with a stubbed
 * token endpoint. They cannot prove that Intuit really answers 401 to a
 * malformed bearer token rather than 400 or 403 — and the whole reactive path
 * hangs on that being a 401. This test is the only thing that closes that gap,
 * so it talks to Intuit for real.
 *
 * HOW IT SETS THE TRAP. It builds an in-memory `Integration` with:
 *   - a deliberately corrupt access token
 *   - a `token_expires_at` an hour in the FUTURE, so nothing refreshes
 *     proactively and the 401 is the first thing that happens
 *   - the REAL refresh token, so the forced refresh can actually succeed
 *
 * WHAT IT CHANGES. The forced refresh rotates the refresh token and the new one
 * is written back to the live row — which is exactly what the hourly sync does
 * in production, through this same code. The connection is left working, and
 * the test asserts that at the end rather than assuming it.
 *
 *   REFRESH_TEST=1 npx vitest run tests/reactive-refresh.integration.test.ts
 */
const ENABLED =
  process.env.REFRESH_TEST === '1' &&
  Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.QBO_CLIENT_ID &&
      process.env.QBO_CLIENT_SECRET &&
      process.env.ENCRYPTION_KEY,
  );

describe.skipIf(!ENABLED)('an access token Intuit rejects early', () => {
  let db: SupabaseClient;
  let live: Integration;

  beforeAll(async () => {
    db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );

    const { data } = await db
      .from('integrations')
      .select('*')
      .eq('provider', 'quickbooks')
      .not('refresh_token_enc', 'is', null)
      .maybeSingle();

    if (!data) throw new Error('no connected QuickBooks integration to test against');
    live = data as Integration;
  }, 60_000);

  it('answers 401 to a bad bearer token, refreshes, and the retry succeeds', async () => {
    const refreshes: string[] = [];

    const trap: Integration = {
      ...live,
      access_token_enc: encryptSecret('deliberately-corrupt-access-token'),
      // In the future on purpose: this is what makes it the REACTIVE path.
      // Without it `getAccessToken` would refresh up front and the 401 would
      // never happen, which would prove nothing.
      token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    };

    const session = createQboSession(trap, async (tokens) => {
      refreshes.push(tokens.token_expires_at);
      const { error } = await db.from('integrations').update(tokens).eq('id', live.id);
      if (error) throw new Error(`could not persist the rotated token: ${error.message}`);
    });

    const accounts = await session.run((accessToken) =>
      fetchQboAccounts(accessToken, live.external_id!),
    );

    // It came back with real data, which can only have happened through the
    // forced refresh — the token it started with was gibberish.
    expect(Array.isArray(accounts)).toBe(true);
    expect(accounts.length, 'no accounts returned; the retry did not really run').toBeGreaterThan(0);

    // Exactly one refresh: the reactive one. More would mean it looped.
    expect(refreshes).toHaveLength(1);
  }, 120_000);

  it('leaves the live connection working', async () => {
    // The rotated refresh token must be the one in the database now. If this
    // fails, the connection is broken and needs reconnecting by hand — so it is
    // asserted rather than hoped for.
    const { data } = await db
      .from('integrations')
      .select('status,refresh_token_enc,token_expires_at')
      .eq('id', live.id)
      .single();

    const row = data as { status: string; refresh_token_enc: string; token_expires_at: string };
    expect(row.refresh_token_enc).toBeTruthy();
    expect(new Date(row.token_expires_at).getTime()).toBeGreaterThan(Date.now());

    // And prove it by using it, rather than trusting the columns.
    const fresh = { ...(data as object), ...row, id: live.id, external_id: live.external_id } as Integration;
    const session = createQboSession({ ...live, ...fresh }, async (tokens) => {
      await db.from('integrations').update(tokens).eq('id', live.id);
    });
    const accounts = await session.run((t) => fetchQboAccounts(t, live.external_id!));
    expect(accounts.length).toBeGreaterThan(0);
  }, 120_000);
});
