import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { noStoreFetch } from '@/lib/supabase/no-store-fetch';

/**
 * Supabase client bound to the caller session cookie.
 *
 * Queries made through this client run under the caller identity, so Row Level
 * Security (supabase/migrations/0002_rls.sql) decides what they can see. This
 * is the client every page and user-facing route handler should use - never
 * the admin client, which bypasses RLS.
 */
export function createSupabaseServerClient() {
  // Next 15 made `cookies()` asynchronous. The adapter methods await it
  // themselves — @supabase/ssr accepts async get/set/remove — so this factory
  // stays synchronous and none of its dozens of callers had to change. The
  // alternative, an async factory, would have touched every page and route to
  // ship a security upgrade, which is the wrong trade for a framework bump.
  return createServerClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'), {
    global: { fetch: noStoreFetch },
    cookies: {
      async get(name: string) {
        return (await cookies()).get(name)?.value;
      },
      async set(name: string, value: string, options: CookieOptions) {
        try {
          (await cookies()).set({ name, value, ...options });
        } catch {
          // Server Components cannot set cookies; middleware refreshes the
          // session instead. Swallowing here is the documented pattern.
        }
      },
      async remove(name: string, options: CookieOptions) {
        try {
          (await cookies()).set({ name, value: '', ...options, maxAge: 0 });
        } catch {
          /* see above */
        }
      },
    },
  });
}

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env.local and fill in the Supabase project values.`,
    );
  }
  return value;
}
