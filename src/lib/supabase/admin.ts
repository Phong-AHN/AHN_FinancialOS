import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { noStoreFetch } from '@/lib/supabase/no-store-fetch';

/**
 * Service-role client. Bypasses Row Level Security.
 *
 * Only trusted server processes may use it: the cron sync, the connectors, the
 * alert dispatcher, and the CSV importer - all of which write on behalf of the
 * system rather than a signed-in person. Never import this into a component or
 * hand its results straight to a browser response without an auth check first.
 */
let cached: SupabaseClient | null = null;

export function createSupabaseAdminClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL are required for server-side sync jobs.',
    );
  }

  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { 'x-application-name': 'ahn-financial-os' },
      fetch: noStoreFetch,
    },
  });
  return cached;
}

export function isAdminConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
