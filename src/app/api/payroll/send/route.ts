import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { crossOriginRefusal } from '@/lib/security';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { recordAudit } from '@/lib/audit';
import { rowsOrThrow } from '@/lib/supabase/rows';
import { runTotal, sendRefusal, refusalsFor, type PayableLine } from '@/lib/payroll/guards';
import { fetchAccessToken, sendPayment, splitName } from '@/lib/connectors/veem';
import { formatMoney } from '@/lib/money';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Send an approved payroll run - Spec section 7.
 *
 * THE ONLY ROUTE IN THIS SYSTEM THAT CAUSES MONEY TO LEAVE. Everything about it
 * is arranged so that the dangerous outcome needs someone to ask for it twice
 * and the safe outcome is what happens by accident.
 *
 *   - **`confirm` must be the literal string "SEND".** Not a boolean: a
 *     mistyped `true`, a stray default, a replayed body with `confirm: 1` —
 *     none of those are the word.
 *   - **Dry run is the default.** Without `confirm`, the route builds every
 *     payload, runs every check and returns exactly what WOULD be sent. There
 *     is no Veem sandbox to rehearse in, so this is the rehearsal.
 *   - **The idempotency key is stored before the call, never after.** Veem
 *     answers a reused `X-Request-Id` with 409, which makes a retry after a
 *     timeout safe — but only if the key survived the crash. It is written by
 *     migration 0036's default at row creation, and this route never
 *     regenerates it.
 *   - **The run is moved to `sending` first.** A second request arriving while
 *     the first is in flight finds a status that refuses.
 *   - **Each line is recorded the moment it returns**, before the next is
 *     attempted. A crash halfway leaves an accurate record of who was paid.
 */
const SendSchema = z.object({
  runId: z.string().uuid(),
  /**
   * The word, or nothing happens. See above.
   */
  confirm: z.literal('SEND').optional(),
});

export async function POST(request: Request) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  const auth = await requireApiSession({ capability: 'disburse' });
  if ('response' in auth) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = SendSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: 'Send needs a run id, and confirm must be the word SEND.' },
      { status: 400 },
    );
  }
  const { runId, confirm } = parsed.data;
  const reallySend = confirm === 'SEND';

  const db = createSupabaseServerClient();

  const { data: runRow } = await db.from('payroll_runs').select('*').eq('id', runId).maybeSingle();
  if (!runRow) return Response.json({ ok: false, error: 'No such payroll run.' }, { status: 404 });
  const run = runRow as {
    id: string;
    name: string;
    status: string;
    currency: string;
    created_by: string | null;
    approved_by: string | null;
    approved_total_minor: number | null;
  };

  const payments = rowsOrThrow<{
    id: string;
    person_id: string | null;
    payee_name: string;
    payee_email: string;
    payee_country: string;
    amount_minor: number;
    currency: string;
    purpose: string;
    request_id: string;
    status: string;
  }>(
    await db.from('payroll_payments').select('*').eq('run_id', runId).eq('status', 'pending'),
    'payroll payments',
  );

  const lines: PayableLine[] = payments.map((p) => ({
    personId: p.person_id,
    payeeName: p.payee_name,
    payeeEmail: p.payee_email,
    payeeCountry: p.payee_country,
    amountMinor: p.amount_minor,
    currency: p.currency,
  }));

  // Both gates, every time — including on a dry run, so the rehearsal tells the
  // truth about whether the real thing would proceed.
  const refusals = refusalsFor(lines);
  const stateRefusal = sendRefusal(run, runTotal(lines));

  if (refusals.length > 0 || stateRefusal) {
    return Response.json(
      { ok: false, dryRun: !reallySend, error: stateRefusal, refusals },
      { status: 400 },
    );
  }

  // --- The rehearsal ---------------------------------------------------------
  if (!reallySend) {
    const preview = await Promise.all(
      payments.map(async (p) => {
        const { firstName, lastName } = splitName(p.payee_name);
        const result = await sendPayment({
          requestId: p.request_id,
          payeeEmail: p.payee_email,
          payeeFirstName: firstName,
          payeeLastName: lastName,
          payeeCountryCode: p.payee_country,
          amountMajor: p.amount_minor / 100,
          currency: p.currency,
          purposeOfPayment: p.purpose,
          fundingMethodId: process.env.VEEM_FUNDING_METHOD_ID ?? null,
          fundingMethodType: process.env.VEEM_FUNDING_METHOD_TYPE ?? null,
        });
        return { payee: p.payee_name, amount: formatMoney(p.amount_minor, p.currency), payload: result.payload };
      }),
    );

    return Response.json({
      ok: true,
      dryRun: true,
      message:
        'Nothing was sent. This is exactly what would be POSTed to Veem. ' +
        'Send for real by passing confirm: "SEND".',
      total: formatMoney(runTotal(lines), run.currency),
      count: preview.length,
      preview,
    });
  }

  // --- The real thing --------------------------------------------------------
  // Claim the run first, so a second request finds a status that refuses.
  const { error: claimError } = await db
    .from('payroll_runs')
    .update({ status: 'sending', updated_at: new Date().toISOString() })
    .eq('id', runId)
    .eq('status', 'approved');

  if (claimError) {
    return Response.json({ ok: false, error: claimError.message }, { status: 400 });
  }

  await recordAudit(
    db,
    [
      {
        table_name: 'payroll_runs',
        record_id: runId,
        field: 'status',
        old_value: 'approved',
        new_value: 'sending',
        reason: `Sending ${payments.length} payments totalling ${formatMoney(runTotal(lines), run.currency)}`,
      },
    ],
    auth.session.user,
  );

  const accessToken = await fetchAccessToken();
  let sent = 0;
  let failed = 0;

  for (const p of payments) {
    const { firstName, lastName } = splitName(p.payee_name);
    let result;
    try {
      result = await sendPayment(
        {
          requestId: p.request_id,
          payeeEmail: p.payee_email,
          payeeFirstName: firstName,
          payeeLastName: lastName,
          payeeCountryCode: p.payee_country,
          amountMajor: p.amount_minor / 100,
          currency: p.currency,
          purposeOfPayment: p.purpose,
          fundingMethodId: process.env.VEEM_FUNDING_METHOD_ID ?? null,
          fundingMethodType: process.env.VEEM_FUNDING_METHOD_TYPE ?? null,
        },
        { accessToken, dryRun: false },
      );
    } catch (err) {
      /*
       * A thrown request is the dangerous case: it may have reached Veem.
       * The row is marked failed with the reason, and the idempotency key is
       * left untouched — so a retry is refused by Veem with 409 if the payment
       * did in fact land.
       */
      result = {
        sent: false,
        payload: {},
        veemPaymentId: null,
        veemStatus: null,
        duplicate: false,
        error: `No answer from Veem: ${err instanceof Error ? err.message : String(err)}. ` +
          'This payment may or may not have been created. Check Veem before retrying.',
      };
    }

    // Written immediately, before the next line is attempted.
    await db
      .from('payroll_payments')
      .update({
        status: result.sent ? 'sent' : 'failed',
        veem_payment_id: result.veemPaymentId,
        veem_status: result.veemStatus,
        error: result.error,
        sent_at: result.sent ? new Date().toISOString() : null,
      })
      .eq('id', p.id);

    if (result.sent) sent += 1;
    else failed += 1;
  }

  await db
    .from('payroll_runs')
    .update({ status: 'sent', sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', runId);

  await recordAudit(
    db,
    [
      {
        table_name: 'payroll_runs',
        record_id: runId,
        field: 'sent',
        old_value: null,
        new_value: `${sent} sent, ${failed} failed`,
        reason: 'Payroll run sent',
      },
    ],
    auth.session.user,
  );

  return Response.json({ ok: true, dryRun: false, sent, failed });
}
