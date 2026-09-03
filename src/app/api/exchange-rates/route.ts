import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { crossOriginRefusal } from '@/lib/security';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { recordAudit } from '@/lib/audit';
import { today } from '@/lib/dates';

export const dynamic = 'force-dynamic';

/**
 * Set the USD rate for a currency - Spec section 3.
 *
 * Until now this table was reachable only by SQL, which was survivable while
 * every account was USD. It stopped being survivable the moment a VND statement
 * could be imported: every dong in the ledger is converted by this number, and
 * a figure that drives the cash total, runway and break-even should not need a
 * database client to correct.
 *
 * Rates are DATED and stored as one row per day. Nothing is overwritten in
 * place, because a report run today and re-run next month for the same period
 * has to produce the same number — which it cannot do if history is rewritten
 * every time the rate moves.
 */
const RateSchema = z.object({
  baseCurrency: z.string().trim().length(3).toUpperCase(),
  /**
   * How many USD one unit of the base currency is worth. VND sits near
   * 0.000038, so the bound is generous at the small end and still rejects the
   * mistake that matters: entering 26000 (dong per dollar) the wrong way round,
   * which would value a single dong at twenty-six thousand dollars.
   */
  rate: z.number().positive().lt(1_000),
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export async function POST(request: Request) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = RateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        ok: false,
        error:
          parsed.error.issues[0]?.message ??
          'A rate is how many USD one unit is worth — for VND that is about 0.000038, not 26000.',
      },
      { status: 400 },
    );
  }

  const { baseCurrency, rate } = parsed.data;
  const asOf = parsed.data.asOf ?? today();

  if (baseCurrency === 'USD' && rate !== 1) {
    return Response.json(
      { ok: false, error: 'One US dollar is one US dollar. USD is always 1.' },
      { status: 400 },
    );
  }

  const db = createSupabaseServerClient();

  const { data: previous } = await db
    .from('exchange_rates')
    .select('rate')
    .eq('base_currency', baseCurrency)
    .eq('quote_currency', 'USD')
    .eq('as_of', asOf)
    .maybeSingle();

  const { error } = await db.from('exchange_rates').upsert(
    {
      base_currency: baseCurrency,
      quote_currency: 'USD',
      rate,
      as_of: asOf,
      source: `manual:${auth.session.email}`,
    },
    { onConflict: 'base_currency,quote_currency,as_of' },
  );

  if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });

  // Every USD figure in the company moves when this does, so it is audited like
  // any other financial control.
  await recordAudit(
    db,
    [
      {
        table_name: 'exchange_rates',
        record_id: crypto.randomUUID(),
        field: `${baseCurrency}/USD @ ${asOf}`,
        old_value: previous ? String((previous as { rate: number }).rate) : null,
        new_value: String(rate),
        reason: 'Exchange rate set by hand',
      },
    ],
    auth.session.user,
  );

  return Response.json({ ok: true, baseCurrency, rate, asOf });
}
