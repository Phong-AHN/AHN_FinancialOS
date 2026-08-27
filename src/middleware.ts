import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

/**
 * Refreshes the Supabase session cookie when it is close to expiring.
 *
 * Server Components cannot write cookies, so without this the access token
 * would expire mid-session and the CEO would be bounced to the login screen
 * while reading the dashboard.
 *
 * WHY NOT `getUser()` HERE. That call validates the token against the Auth
 * server in Tokyo - about 159ms measured from Vietnam - and it ran on every
 * single request, including the ones whose token had another 59 minutes to
 * live. `getSession()` reads the cookie and decodes it locally, and only goes
 * to the network when the token has actually expired and needs exchanging.
 *
 * This is a refresh, not an authorisation check, so the local read is the right
 * tool: every guarded page and route handler still calls `getUser()` itself
 * through `getSession()` in `@/lib/auth`, which is where the token is actually
 * verified. Nothing is trusted on the strength of this function.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request: { headers: request.headers } });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      get(name: string) {
        return request.cookies.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        request.cookies.set({ name, value, ...options });
        response = NextResponse.next({ request: { headers: request.headers } });
        response.cookies.set({ name, value, ...options });
      },
      remove(name: string, options: CookieOptions) {
        request.cookies.set({ name, value: '', ...options });
        response = NextResponse.next({ request: { headers: request.headers } });
        response.cookies.set({ name, value: '', ...options, maxAge: 0 });
      },
    },
  });

  // Refreshes in place when expired; a plain cookie read when not.
  await supabase.auth.getSession();
  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and the cron routes. Cron carries a
     * bearer secret rather than a session cookie, so a refresh attempt there is
     * pure overhead on a job that runs every ten minutes.
     */
    '/((?!_next/static|_next/image|favicon.ico|api/cron|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
