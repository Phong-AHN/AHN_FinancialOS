import { requireApiSession } from '@/lib/auth';
import { createSupabaseAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { fetchStripeBalance, stripeConfigured } from '@/lib/connectors/stripe';
import { saveIntegrationTokens, syncStripe } from '@/lib/sync';
import type { Integration } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Stripe has no OAuth step for a first-party account - the secret key IS the
 * credential. This verifies the key actually works before recording anything,
 * so a typo surfaces here rather than as a silent cron failure hours later.
 */
export async function POST() {
  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  if (!stripeConfigured()) {
    return Response.json({ ok: false, error: 'STRIPE_SECRET_KEY is not set.' }, { status: 400 });
  }
  if (!isAdminConfigured()) {
    return Response.json({ ok: false, error: 'Supabase service role is not configured.' }, { status: 500 });
  }

  try {
    const balances = await fetchStripeBalance();
    const db = createSupabaseAdminClient();

    const integration = await saveIntegrationTokens(db, {
      provider: 'stripe',
      externalId: 'default',
      label: 'Stripe account',
      // Stored encrypted like every other credential, even though it also lives
      // in the environment - the sync path reads credentials one way only.
      accessToken: process.env.STRIPE_SECRET_KEY!,
      metadata: { connected_by: auth.session.email, currencies: Object.keys(balances) },
    });

    const result = await syncStripe(db, integration as Integration);
    return Response.json({ ok: true, inserted: result.inserted, error: result.error });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'Could not verify the Stripe key.' },
      { status: 502 },
    );
  }
}
