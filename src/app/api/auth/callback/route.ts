import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Email sign-in landing point.
 *
 * Supabase sends people back here in one of two shapes, depending on how the
 * project's email template is written, and a callback that handles only one of
 * them fails with a confusing "missing code" for half of all setups:
 *
 *   ?token_hash=...&type=magiclink   the default {{ .ConfirmationURL }} template
 *   ?code=...                        the PKCE flow
 *
 * There is a third shape - an implicit-flow `#access_token=...` fragment. A
 * fragment is never sent to the server, so it cannot be handled here at all;
 * `AuthHashHandler` on the login page picks that one up in the browser.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const supabase = createSupabaseServerClient();

  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const next = searchParams.get('next') ?? '/';

  // Supabase reports its own failures (expired link, already used) as query
  // params rather than as a missing code. Surface the real reason.
  const providerError = searchParams.get('error_description') ?? searchParams.get('error');
  if (providerError) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(providerError)}`);
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (error) {
      return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`);
    }
    return NextResponse.redirect(`${origin}${next}`);
  }

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`);
    }
    return NextResponse.redirect(`${origin}${next}`);
  }

  return NextResponse.redirect(
    `${origin}/login?error=${encodeURIComponent(
      'That sign-in link carried no token. It may have already been used, or expired — request a new one.',
    )}`,
  );
}
