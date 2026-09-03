import { requireApiSession } from '@/lib/auth';
import { callerKey, crossOriginRefusal, rateLimitRefusal } from '@/lib/security';
import { createLinkToken, plaidConfigured } from '@/lib/connectors/plaid';

export const dynamic = 'force-dynamic';

/** Short-lived token that opens Plaid Link in the browser. */
export async function POST(request: Request) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  // Calls Plaid to mint a Link token.
  const tooMany = rateLimitRefusal(callerKey(request, 'bank-connect'), {
    limit: 6,
    windowMs: 60000,
  });
  if (tooMany) return tooMany;

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
