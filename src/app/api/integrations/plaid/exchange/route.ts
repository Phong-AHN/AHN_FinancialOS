import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { crossOriginRefusal } from '@/lib/security';
import { createSupabaseAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { exchangePublicToken, plaidConfigured } from '@/lib/connectors/plaid';
import { saveIntegrationTokens, syncPlaid } from '@/lib/sync';
import type { Integration } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Schema = z.object({ publicToken: z.string().min(10).max(500) });

/**
 * Swap Plaid short-lived public token for a long-lived access token.
 *
 * The access token is encrypted with AES-256-GCM before it touches the
 * database. Bank credentials themselves never reach this application at all -
 * they are entered inside Plaid own iframe (spec section 25).
 */
export async function POST(request: Request) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  if (!plaidConfigured()) {
    return Response.json({ ok: false, error: 'Plaid is not configured.' }, { status: 400 });
  }
  if (!isAdminConfigured()) {
    return Response.json({ ok: false, error: 'Supabase service role is not configured.' }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'Missing public token.' }, { status: 400 });
  }

  try {
    const { access_token, item_id } = await exchangePublicToken(parsed.data.publicToken);
    const db = createSupabaseAdminClient();

    const integration = await saveIntegrationTokens(db, {
      provider: 'plaid',
      externalId: item_id,
      label: 'Plaid item',
      accessToken: access_token,
      metadata: { connected_by: auth.session.email },
    });

    const result = await syncPlaid(db, integration as Integration);
    return Response.json({ ok: true, inserted: result.inserted, accounts: result.accounts_touched });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'Could not connect Plaid.' },
      { status: 502 },
    );
  }
}
