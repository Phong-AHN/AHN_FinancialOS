import { requireApiSession } from '@/lib/auth';
import { callerKey, crossOriginRefusal, rateLimitRefusal } from '@/lib/security';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { today } from '@/lib/dates';
import {
  ScreenshotReadError,
  readScreenshot,
  screenshotImportConfigured,
  sniffImageType,
} from '@/lib/image-import/read-screenshot';
import { externalIdFor, reviewScreenshot } from '@/lib/image-import/review';

export const dynamic = 'force-dynamic';
// Vercel's maximum with fluid compute on every plan. A screenshot read at
// full effort can take well over a minute; 60 seconds was cutting it off.
export const maxDuration = 300;

/**
 * Read ONE screenshot and return rows for a person to check. Saves nothing.
 *
 * The image is read and discarded: it is not written to storage, the database
 * or a log. What reaches the ledger is only what somebody approves afterwards,
 * through `/api/import/screenshot/commit`.
 */

/** Vercel refuses request bodies over 4.5 MB; the browser shrinks images to fit. */
const MAX_BYTES = 4_500_000;

export async function POST(request: Request) {
  const crossOrigin = crossOriginRefusal(request);
  if (crossOrigin) return crossOrigin;

  // Every call is a paid model request. Generous for a person working through
  // a month of screenshots; a wall for anything scripted.
  const tooMany = rateLimitRefusal(callerKey(request, 'screenshot-read'), { limit: 150, windowMs: 60 * 60_000 });
  if (tooMany) return tooMany;

  const auth = await requireApiSession({ ownerOnly: true });
  if ('response' in auth) return auth.response;

  if (!screenshotImportConfigured()) {
    return Response.json(
      { ok: false, error: 'Screenshot import is not set up: ANTHROPIC_API_KEY is missing.' },
      { status: 503 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ ok: false, error: 'Expected a screenshot upload.' }, { status: 400 });
  }

  const file = form.get('image');
  const accountId = String(form.get('accountId') ?? '');
  const index = Math.max(0, Math.min(999, Number(form.get('index') ?? 0) || 0));

  if (!(file instanceof File)) return Response.json({ ok: false, error: 'No image attached.' }, { status: 400 });
  if (file.size > MAX_BYTES) {
    return Response.json({ ok: false, error: 'That image is over 4.5 MB. Take a shorter screenshot.' }, { status: 413 });
  }
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) {
    return Response.json({ ok: false, error: 'Choose the account these screenshots are from.' }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  // The file's own first bytes decide what it is, not the name or the
  // browser's label — a renamed PDF is not a PNG.
  const mediaType = sniffImageType(bytes);
  if (!mediaType) {
    return Response.json({ ok: false, error: 'That is not a PNG, JPEG or WebP image.' }, { status: 415 });
  }

  const db = createSupabaseServerClient();
  const { data: account, error: accountError } = await db
    .from('financial_accounts')
    .select('id,name,currency')
    .eq('id', accountId)
    .maybeSingle();
  if (accountError) return Response.json({ ok: false, error: accountError.message }, { status: 400 });
  if (!account) return Response.json({ ok: false, error: 'No such account.' }, { status: 404 });

  let read;
  try {
    read = await readScreenshot({ data: bytes, mediaType });
  } catch (err) {
    if (err instanceof ScreenshotReadError) {
      const status = err.kind === 'rate_limited' ? 429 : err.kind === 'not_configured' ? 503 : 422;
      return Response.json({ ok: false, error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ ok: false, error: 'The screenshot could not be read.' }, { status: 500 });
  }

  const rows = reviewScreenshot(read.reading, index, { today: today() });
  for (const r of rows) r.readBy = read.model;

  // Already in the ledger from an earlier import of the same screenshot.
  const ids = rows.map((r) => externalIdFor(account.id as string, r.key));
  if (ids.length) {
    const { data: held, error: heldError } = await db
      .from('transactions')
      .select('external_txn_id')
      .eq('source_system', 'image_vn_bank')
      .in('external_txn_id', ids);
    if (heldError) return Response.json({ ok: false, error: heldError.message }, { status: 400 });
    const already = new Set((held ?? []).map((h) => (h as { external_txn_id: string }).external_txn_id));
    for (const r of rows) {
      if (already.has(externalIdFor(account.id as string, r.key))) r.issues.push('already_imported');
    }
  }

  return Response.json({
    ok: true,
    screen: {
      bank: read.reading.bank,
      title: read.reading.screen_title,
      tab: read.reading.tab,
      isTransactionList: read.reading.is_transaction_list,
      postedScreen: read.reading.shows_posted_transactions,
    },
    rows,
    model: read.model,
    usage: read.usage,
  });
}
