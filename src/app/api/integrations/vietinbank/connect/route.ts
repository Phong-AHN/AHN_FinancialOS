import { requireApiSession } from '@/lib/auth';
import { callerKey, crossOriginRefusal, rateLimitRefusal } from '@/lib/security';
import { createSupabaseAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { fetchStatement, vietinbankConfigProblems } from '@/lib/connectors/vietinbank';
import { addDays, today } from '@/lib/dates';

export const dynamic = 'force-dynamic';

/**
 * Connect the VietinBank statement feed - Spec section 2.
 *
 * There is no OAuth handshake to perform: the two apiKey headers ARE the
 * credential. So "connecting" means proving they work, by asking for a short
 * statement and reading the status code out of the body.
 *
 * That check matters because the gateway answers HTTP 200 with a failure code
 * inside. Storing the integration on `res.ok` alone would mark it connected
 * while every sync silently returned nothing.
 */
export async function POST(request: Request) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  // Calls the bank gateway. Repeated failed authentication is exactly the pattern that
  // gets an API key suspended.
  const tooMany = rateLimitRefusal(callerKey(request, 'bank-connect'), {
    limit: 6,
    windowMs: 60000,
  });
  if (tooMany) return tooMany;

  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  if (!isAdminConfigured()) {
    return Response.json({ ok: false, error: 'Supabase service role is not configured.' }, { status: 500 });
  }

  const problems = vietinbankConfigProblems();
  if (problems.length) {
    return Response.json({ ok: false, error: problems.join(' ') }, { status: 400 });
  }

  const accountNumber = process.env.VIETINBANK_ACCOUNT_NUMBER!;
  const asOf = today();

  try {
    // A week is enough to prove the credentials and the account number without
    // pulling a year of statement just to say hello.
    const statement = await fetchStatement({
      account: accountNumber,
      from: addDays(asOf, -7),
      to: asOf,
    });

    const db = createSupabaseAdminClient();
    const { error } = await db.from('integrations').upsert(
      {
        provider: 'vietinbank',
        external_id: accountNumber,
        label: statement.companyName
          ? `${statement.companyName} — ${accountNumber}`
          : `VietinBank ${accountNumber}`,
        status: 'connected',
        last_error: null,
      },
      { onConflict: 'provider,external_id' },
    );

    if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });

    return Response.json({
      ok: true,
      account: statement.account ?? accountNumber,
      companyName: statement.companyName ?? null,
      currency: statement.curency ?? null,
      transactionsInLastWeek: statement.transactions?.length ?? 0,
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'Could not reach VietinBank.' },
      { status: 502 },
    );
  }
}
