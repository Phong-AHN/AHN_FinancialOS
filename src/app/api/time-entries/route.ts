import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { crossOriginRefusal } from '@/lib/security';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Log hours against a project - Spec section 13.
 *
 * Upserts on (person, project, day). A second submission for the same day is a
 * correction, not an addition: without that, a double-clicked form doubles
 * somebody's cost and the project quietly looks worse.
 *
 * NO CAPABILITY GATE, and that is deliberate. This route once required
 * `move_money`, which meant the owner had to type everybody's timesheet — so
 * nobody's timesheet got typed, and every project margin in the app carried a
 * caveat that labour was not counted.
 *
 * Migration 0029 moved the rule to where it can be trusted: an employee may
 * write rows for their OWN person, dated within the last fortnight, and Postgres
 * refuses everything else. `person_id` is read from the body here without being
 * checked against the caller — it does not need to be, because the policy is
 * both "may I write" and "may I write AS this person". Adding a check here as
 * well would suggest the database's is optional.
 */
const EntrySchema = z.object({
  personId: z.string().uuid(),
  projectId: z.string().uuid(),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // A day has 24 hours. Anything more is a typo, and a typo here becomes a
  // cost that shows up as a project losing money.
  hours: z.number().positive().max(24),
  notes: z.string().trim().max(500).nullable().optional(),
});

export async function POST(request: Request) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  // Signed in is the only check here; RLS decides whose hours may be written.
  const auth = await requireApiSession();
  if ('response' in auth) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = EntrySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid time entry.' },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const db = createSupabaseServerClient();
  const { data, error } = await db
    .from('time_entries')
    .upsert(
      {
        person_id: input.personId,
        project_id: input.projectId,
        work_date: input.workDate,
        hours: input.hours,
        notes: input.notes ?? null,
      },
      { onConflict: 'person_id,project_id,work_date' },
    )
    .select('id')
    .single();

  if (error) {
    // A policy refusal reads as an empty result or a permission error rather
    // than as anything a person could act on, so it is translated once, here.
    return Response.json({ ok: false, error: friendlyRefusal(error.message) }, { status: 400 });
  }
  return Response.json({ ok: true, id: (data as { id: string }).id });
}

export async function DELETE(request: Request) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  const auth = await requireApiSession();
  if ('response' in auth) return auth.response;

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'Missing id.' }, { status: 400 });

  const db = createSupabaseServerClient();
  const { error } = await db.from('time_entries').delete().eq('id', id);
  if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });
  return Response.json({ ok: true });
}

/**
 * Turn a policy refusal into something the person reading it can act on.
 *
 * Postgres says "new row violates row-level security policy". True, and
 * useless: the reader needs to know it is either not their timesheet or not a
 * date they may still change.
 */
function friendlyRefusal(message: string): string {
  if (/row-level security/i.test(message)) {
    return (
      'You can only log hours for yourself, and only for the last fortnight. ' +
      'Ask an owner to record anything older.'
    );
  }
  return message;
}
