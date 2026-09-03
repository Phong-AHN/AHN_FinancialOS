import { requireApiSession } from '@/lib/auth';
import { callerKey, crossOriginRefusal, rateLimitRefusal } from '@/lib/security';
import { createLinkToken, fetchCustomerToken, finverseConfigProblems } from '@/lib/connectors/finverse';

export const dynamic = 'force-dynamic';

/**
 * Start the Finverse Link flow - Spec section 2.
 *
 * Returns a hosted URL. The person signs in to Techcombank, Vietcombank or VP
 * Bank on Finverse's page; we never see the bank credentials, which is the
 * whole reason to go through an aggregator rather than holding them ourselves.
 */
export async function POST(request: Request) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  // Calls the aggregator to mint a Link token.
  const tooMany = rateLimitRefusal(callerKey(request, 'bank-connect'), {
    limit: 6,
    windowMs: 60000,
  });
  if (tooMany) return tooMany;

  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  const problems = finverseConfigProblems();
  if (problems.length) {
    // Say which of the four things is missing. An integration that reports
    // "not connected" without saying why costs an hour of guessing.
    return Response.json({ ok: false, error: problems.join(' ') }, { status: 400 });
  }

  try {
    const token = await fetchCustomerToken();
    const link = await createLinkToken(token.accessToken, auth.session.user.id);
    return Response.json({ ok: true, linkUrl: link.linkUrl });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'Could not start the Link flow.' },
      { status: 502 },
    );
  }
}
