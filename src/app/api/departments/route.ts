import { z } from 'zod';
import { requireApiSession } from '@/lib/auth';
import { crossOriginRefusal } from '@/lib/security';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { recordAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Departments - Spec section 19.
 *
 * A department owns section 7 spend categories rather than carrying a tag on
 * every transaction, so "Marketing spent $4,000 against a $5,000 budget" is
 * answerable from data that already exists. Migration 0035 guarantees no
 * category belongs to two departments; this route turns that refusal into a
 * sentence.
 */
const CreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** Section 7 category keys. Empty is allowed: a department can be set up before its categories are decided. */
  categories: z.array(z.string().trim().min(1).max(60)).max(40).default([]),
  sortOrder: z.number().int().min(0).max(9_999).optional(),
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

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? 'That department is not valid.' },
      { status: 400 },
    );
  }
  const input = parsed.data;
  const db = createSupabaseServerClient();

  const { data, error } = await db
    .from('departments')
    .insert({
      name: input.name,
      categories: input.categories,
      sort_order: input.sortOrder ?? 0,
    })
    .select('id')
    .single();

  if (error) {
    // P0001 is the trigger: another department already owns one of these
    // categories, and its message already names which one.
    const message = /already belongs to another department/i.test(error.message)
      ? error.message
      : /duplicate key|unique/i.test(error.message)
        ? 'A department with that name already exists.'
        : error.message;
    return Response.json({ ok: false, error: message }, { status: 400 });
  }

  const id = (data as { id: string }).id;
  await recordAudit(
    db,
    [
      {
        table_name: 'departments',
        record_id: id,
        field: 'created',
        old_value: null,
        new_value: `${input.name} — ${input.categories.join(', ') || 'no categories yet'}`,
        reason: 'Department created',
      },
    ],
    auth.session.user,
  );

  return Response.json({ ok: true, id });
}

export async function DELETE(request: Request) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'Missing id.' }, { status: 400 });

  const db = createSupabaseServerClient();
  const { error } = await db.from('departments').delete().eq('id', id);
  if (error) return Response.json({ ok: false, error: error.message }, { status: 400 });
  return Response.json({ ok: true });
}
