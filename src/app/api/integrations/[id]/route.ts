import { requireApiSession } from '@/lib/auth';
import { crossOriginRefusal } from '@/lib/security';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { recordAudit } from '@/lib/audit';
import { decryptSecret } from '@/lib/crypto';
import { revokeTokens } from '@/lib/connectors/quickbooks';
import { recordIntegrationError } from '@/lib/integration-errors';
import type { Integration } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Disconnect a provider - Intuit's Disconnect URL requirement, and the thing
 * the privacy policy already promised.
 *
 * THE POLICY WAS AHEAD OF THE CODE. `/privacy` said "AHN can disconnect any
 * linked account at any time from the Integrations page, which revokes the
 * stored token". There was no such control and no revoke call anywhere — a
 * written claim to a regulator's reviewer that the software did not honour.
 * This route is what makes that sentence true.
 *
 * DISCONNECTING IS TWO ACTIONS, NOT ONE:
 *
 *   1. Tell the provider to forget the grant. Skipping this leaves the app
 *      listed in the company's Connected Apps with a live token.
 *   2. Delete our copy. Skipping this leaves a decryptable refresh token in a
 *      row nobody thinks is live any more.
 *
 * They are done in that order, because if the revoke fails we still hold the
 * token needed to retry it. Clearing our copy first would strand the grant
 * permanently — revocable only from inside QuickBooks, by hand.
 */
export async function DELETE(
  request: Request,
  props: { params: Promise<{ id: string }> },
): Promise<Response> {
  const params = await props.params;
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  const db = createSupabaseServerClient();
  const { data, error } = await db
    .from('integrations')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();

  if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });
  if (!data) return Response.json({ ok: false, error: 'No such connection.' }, { status: 404 });

  const integration = data as Integration;

  // Step 1. Only QuickBooks has a revocation endpoint we hold credentials for.
  // The others are disconnected at the provider, and saying otherwise here
  // would be the same overclaim this route exists to fix.
  let revoked: string;
  if (integration.provider === 'quickbooks' && integration.refresh_token_enc) {
    try {
      await revokeTokens(decryptSecret(integration.refresh_token_enc));
      revoked = 'revoked at Intuit';
    } catch (err) {
      await recordIntegrationError(db, {
        integrationId: integration.id,
        provider: 'quickbooks',
        operation: 'disconnect',
        error: err,
      });
      // Stop here and keep the token. A failed revoke that still wiped our copy
      // would report success while leaving the grant live forever.
      return Response.json(
        {
          ok: false,
          error:
            err instanceof Error
              ? `${err.message} The connection was left in place so this can be retried.`
              : 'Could not revoke the token at Intuit.',
        },
        { status: 502 },
      );
    }
  } else {
    revoked = 'no provider-side revocation for this provider';
  }

  // Step 2. The row survives so that reconnecting updates it rather than
  // orphaning it, and so the audit trail still has something to point at. What
  // does not survive is anything that could be used to reach the account again.
  const { error: clearError } = await db
    .from('integrations')
    .update({
      status: 'disconnected',
      access_token_enc: null,
      refresh_token_enc: null,
      token_expires_at: null,
      last_cursor: null,
      last_error: null,
    })
    .eq('id', integration.id);

  if (clearError) {
    return Response.json({ ok: false, error: clearError.message }, { status: 400 });
  }

  await recordAudit(
    db,
    [
      {
        table_name: 'integrations',
        record_id: integration.id,
        field: 'status',
        old_value: integration.status,
        new_value: 'disconnected',
        reason: `Disconnected by ${auth.session.email} — ${revoked}, stored tokens deleted`,
      },
    ],
    auth.session.user,
  );

  return Response.json({ ok: true, revoked });
}
