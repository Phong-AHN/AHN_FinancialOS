import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import { createSupabaseAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { exchangeCodeForTokens } from '@/lib/connectors/quickbooks';
import { saveIntegrationTokens, syncQuickBooks } from '@/lib/sync';
import { safeEqual } from '@/lib/crypto';
import { recordIntegrationError } from '@/lib/integration-errors';
import type { Integration } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const STATE_COOKIE = 'qbo_oauth_state';

function fail(request: Request, message: string): NextResponse {
  return NextResponse.redirect(
    new URL(`/integrations?error=${encodeURIComponent(message)}`, request.url),
  );
}

/** OAuth2 return leg: verify state, swap the code, store encrypted, sync once. */
export async function GET(request: Request) {
  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return NextResponse.redirect(new URL('/login', request.url));

  if (!isAdminConfigured()) return fail(request, 'Supabase service role is not configured.');

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const realmId = url.searchParams.get('realmId');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) return fail(request, `QuickBooks returned: ${oauthError}`);
  if (!code || !realmId || !state) return fail(request, 'QuickBooks did not return a usable response.');

  const cookieStore = await cookies();
  const expected = cookieStore.get(STATE_COOKIE)?.value;
  cookieStore.delete(STATE_COOKIE);
  if (!expected || !safeEqual(state, expected)) {
    return fail(request, 'The connection request could not be verified. Please start again.');
  }

  const db = createSupabaseAdminClient();

  /*
   * ONE QUICKBOOKS COMPANY AT A TIME.
   *
   * Every company numbers its records from 1, and a transaction here is keyed
   * `Purchase:123` with no company in the key. Connecting a second company while
   * the first one's rows are still held would make its `Purchase:123` a
   * "duplicate" of the other's — skipped without a word — and merge its bank
   * accounts into the other company's accounts with the same id. The ledger
   * would look fine and be wrong.
   *
   * Checked BEFORE the code is exchanged. Refusing afterwards would leave Intuit
   * holding a grant for this app that nothing here has the token to revoke.
   */
  const { data: others, error: othersError } = await db
    .from('integrations')
    .select('external_id,label')
    .eq('provider', 'quickbooks')
    .neq('external_id', realmId);
  if (othersError) return fail(request, `Could not check existing connections: ${othersError.message}`);
  if ((others ?? []).length > 0) {
    const other = others![0] as { external_id: string; label: string | null };
    return fail(
      request,
      `${other.label ?? `QuickBooks company ${other.external_id}`} is still on record. Its records would collide ` +
        `with this company's, so it has to be cleared first: disconnect it, then run ` +
        `"node scripts/purge-quickbooks-sandbox.mjs --realm ${other.external_id}" and connect again.`,
    );
  }

  try {
    const tokens = await exchangeCodeForTokens(code);

    const integration = await saveIntegrationTokens(db, {
      provider: 'quickbooks',
      externalId: realmId,
      label: `QuickBooks company ${realmId}`,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresInSeconds: tokens.expires_in,
      metadata: { connected_by: auth.session.email },
    });

    // Pull straight away so the dashboard has data by the time the redirect
    // lands, rather than looking broken until the next cron tick.
    await syncQuickBooks(db, integration as Integration);

    return NextResponse.redirect(new URL('/integrations?connected=QuickBooks', request.url));
  } catch (err) {
    // A failed connect is exactly what somebody asks Intuit's support about,
    // and the code exchange is where the intuit_tid lives.
    await recordIntegrationError(db, {
      integrationId: null,
      provider: 'quickbooks',
      operation: 'connect',
      error: err,
    });
    return fail(request, err instanceof Error ? err.message : 'Could not connect QuickBooks.');
  }
}
