import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import { createSupabaseAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { exchangeCodeForTokens } from '@/lib/connectors/quickbooks';
import { saveIntegrationTokens, syncQuickBooks } from '@/lib/sync';
import { safeEqual } from '@/lib/crypto';
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

  const expected = cookies().get(STATE_COOKIE)?.value;
  cookies().delete(STATE_COOKIE);
  if (!expected || !safeEqual(state, expected)) {
    return fail(request, 'The connection request could not be verified. Please start again.');
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const db = createSupabaseAdminClient();

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
    return fail(request, err instanceof Error ? err.message : 'Could not connect QuickBooks.');
  }
}
