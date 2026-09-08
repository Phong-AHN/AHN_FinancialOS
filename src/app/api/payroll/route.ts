import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { crossOriginRefusal } from '@/lib/security';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { recordAudit } from '@/lib/audit';
import { rowsOrThrow } from '@/lib/supabase/rows';
import { refusalsFor, runTotal, type PayableLine } from '@/lib/payroll/guards';
import { formatMoney } from '@/lib/money';

export const dynamic = 'force-dynamic';

/**
 * Prepare and approve a payroll run - Spec section 7.
 *
 * Sending lives in `/api/payroll/send`, deliberately in its own file: the route
 * that moves money should not share a body with the one that drafts a list.
 */
const CreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.string().trim().length(3).toUpperCase().default('USD'),
  lines: z
    .array(
      z.object({
        personId: z.string().uuid().nullable(),
        payeeName: z.string().trim().min(1).max(200),
        payeeEmail: z.string().trim().email().max(320),
        payeeCountry: z.string().trim().length(2).toUpperCase(),
        amountMinor: z.number().int().positive(),
        purpose: z.string().trim().max(200).optional(),
      }),
    )
    .min(1),
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

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? 'That run is not valid.' },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // The same guards the send route applies, run now — so a bad line is caught
  // while somebody is still assembling, not at the moment of payment.
  const lines: PayableLine[] = input.lines.map((l) => ({
    personId: l.personId,
    payeeName: l.payeeName,
    payeeEmail: l.payeeEmail,
    payeeCountry: l.payeeCountry,
    amountMinor: l.amountMinor,
    currency: input.currency,
  }));
  const refusals = refusalsFor(lines);
  if (refusals.length > 0) {
    return Response.json({ ok: false, error: 'This run cannot be paid.', refusals }, { status: 400 });
  }

  const db = createSupabaseServerClient();
  const { data: runRow, error } = await db
    .from('payroll_runs')
    .insert({
      name: input.name,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      currency: input.currency,
      status: 'draft',
      created_by: auth.session.user.id,
    })
    .select('id')
    .single();

  if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });
  const runId = (runRow as { id: string }).id;

  const { error: linesError } = await db.from('payroll_payments').insert(
    input.lines.map((l) => ({
      run_id: runId,
      person_id: l.personId,
      payee_name: l.payeeName,
      payee_email: l.payeeEmail,
      payee_country: l.payeeCountry,
      amount_minor: l.amountMinor,
      currency: input.currency,
      purpose: l.purpose ?? `Payroll ${input.periodStart} to ${input.periodEnd}`,
    })),
  );

  if (linesError) {
    // A run with no lines is worse than no run: it looks approvable.
    await db.from('payroll_runs').delete().eq('id', runId);
    return Response.json({ ok: false, error: linesError.message }, { status: 400 });
  }

  await recordAudit(
    db,
    [
      {
        table_name: 'payroll_runs',
        record_id: runId,
        field: 'created',
        old_value: null,
        new_value: `${input.lines.length} people, ${formatMoney(runTotal(lines), input.currency)}`,
        reason: 'Payroll run prepared',
      },
    ],
    auth.session.user,
  );

  return Response.json({ ok: true, id: runId, total: formatMoney(runTotal(lines), input.currency) });
}

/**
 * Approve or cancel.
 *
 * The approver must not be the preparer — enforced by migration 0036's trigger,
 * not here, so it holds whatever calls it. This route freezes the total at the
 * moment of approval, which is what the send route later checks against.
 */
const PatchSchema = z.object({
  runId: z.string().uuid(),
  action: z.enum(['approve', 'cancel']),
});

export async function PATCH(request: Request) {
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

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'Needs a run id and an action.' }, { status: 400 });
  }
  const { runId, action } = parsed.data;
  const db = createSupabaseServerClient();

  if (action === 'cancel') {
    const { error } = await db
      .from('payroll_runs')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', runId)
      .eq('status', 'draft');
    if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });
    return Response.json({ ok: true });
  }

  const pending = rowsOrThrow<{ amount_minor: number }>(
    await db.from('payroll_payments').select('amount_minor').eq('run_id', runId).eq('status', 'pending'),
    'payroll payments',
  );
  const total = pending.reduce((sum, p) => sum + p.amount_minor, 0);

  const { error } = await db
    .from('payroll_runs')
    .update({
      status: 'approved',
      approved_by: auth.session.user.id,
      approved_at: new Date().toISOString(),
      // Frozen here. The send route refuses if the live total has moved since.
      approved_total_minor: total,
      updated_at: new Date().toISOString(),
    })
    .eq('id', runId)
    .eq('status', 'draft');

  if (error) {
    // The trigger's message is written for a person to read.
    return Response.json({ ok: false, error: error.message }, { status: 400 });
  }

  await recordAudit(
    db,
    [
      {
        table_name: 'payroll_runs',
        record_id: runId,
        field: 'status',
        old_value: 'draft',
        new_value: 'approved',
        reason: `Approved at ${formatMoney(total)}`,
      },
    ],
    auth.session.user,
  );

  return Response.json({ ok: true, approvedTotal: formatMoney(total) });
}
