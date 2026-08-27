import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import { buildAuthorizeUrl, qboConfigured } from '@/lib/connectors/quickbooks';

export const dynamic = 'force-dynamic';

const STATE_COOKIE = 'qbo_oauth_state';

/**
 * Start the QuickBooks OAuth2 flow - MVP Plan Day 2.
 *
 * The `state` value is generated here, stored in an httpOnly cookie and checked
 * on the way back. Without it, an attacker could hand the owner a crafted
 * callback URL and attach THEIR QuickBooks company to AHN account.
 */
export async function GET(request: Request) {
  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  if (!qboConfigured()) {
    return NextResponse.redirect(
      new URL('/integrations?error=QuickBooks+credentials+are+not+set', request.url),
    );
  }

  const state = randomBytes(24).toString('base64url');
  cookies().set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });

  return NextResponse.redirect(buildAuthorizeUrl(state));
}
