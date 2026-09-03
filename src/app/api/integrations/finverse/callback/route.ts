import { requireApiSession } from '@/lib/auth';
import { crossOriginRefusal } from '@/lib/security';
import { createSupabaseAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { encryptSecret } from '@/lib/crypto';
import { finverseEnvironment } from '@/lib/connectors/finverse';

export const dynamic = 'force-dynamic';

/**
 * Where Finverse returns the person after they sign in at their bank.
 *
 * It hands back a LOGIN IDENTITY id and its token. That token — not the bank
 * credentials, which we never receive — is what authorises the data calls, so
 * it is encrypted at rest like every other provider secret.
 *
 * Registered as `FINVERSE_REDIRECT_URI`, and it has to match what Finverse
 * holds character for character or the flow fails at the last step.
 */
export async function POST(request: Request) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  if (!isAdminConfigured()) {
    return Response.json({ ok: false, error: 'Supabase service role is not configured.' }, { status: 500 });
  }

  let body: Record<string, unknown>;
  try {
    const contentType = request.headers.get('content-type') ?? '';
    // Finverse posts `form_post` by default; accept JSON too so the flow can be
    // driven from a test without pretending to be a browser form.
    body = contentType.includes('application/json')
      ? ((await request.json()) as Record<string, unknown>)
      : Object.fromEntries((await request.formData()).entries());
  } catch {
    return Response.json({ ok: false, error: 'Could not read the callback body.' }, { status: 400 });
  }

  const loginIdentityId = String(body.login_identity_id ?? body.loginIdentityId ?? '');
  const loginIdentityToken = String(body.login_identity_token ?? body.access_token ?? '');
  const institutionName = String(body.institution_name ?? body.institution_id ?? 'Vietnamese bank');

  if (!loginIdentityId || !loginIdentityToken) {
    return Response.json(
      { ok: false, error: 'Finverse returned no login identity. The Link flow did not complete.' },
      { status: 400 },
    );
  }

  const db = createSupabaseAdminClient();

  // Keyed on the login identity, so re-linking the same bank updates the
  // existing connection instead of creating a second one that would sync the
  // same transactions twice.
  const { error } = await db.from('integrations').upsert(
    {
      provider: 'finverse',
      external_id: loginIdentityId,
      label: `${institutionName} (${finverseEnvironment()})`,
      status: 'connected',
      access_token_enc: encryptSecret(loginIdentityToken),
      last_error: null,
    },
    { onConflict: 'provider,external_id' },
  );

  if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });
  return Response.json({ ok: true, loginIdentityId });
}
