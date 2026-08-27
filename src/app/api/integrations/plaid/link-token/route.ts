import { requireApiSession } from '@/lib/auth';
import { createLinkToken, plaidConfigured } from '@/lib/connectors/plaid';

export const dynamic = 'force-dynamic';

/** Short-lived token that opens Plaid Link in the browser. */
export async function POST() {
  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  if (!plaidConfigured()) {
    return Response.json({ error: 'PLAID_CLIENT_ID / PLAID_SECRET are not set.' }, { status: 400 });
  }

  try {
    const linkToken = await createLinkToken(auth.session.user.id);
    return Response.json({ linkToken });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Could not create a Plaid link token.' },
      { status: 502 },
    );
  }
}
