'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass, Callout } from '@/components/ui';
import { formatMoney, parseAmount, toMajor, toMinor } from '@/lib/money';
import { planSlices } from '@/lib/image-import/slices';
import {
  ISSUE_TEXT,
  mergeReviewRows,
  normaliseTime,
  parseScreenDateTime,
  type ReviewRow,
  type RowIssue,
} from '@/lib/image-import/review';
import type { FinancialAccount, TxnDirection } from '@/lib/types';

/**
 * Import transactions from screenshots of a Vietnamese banking app.
 *
 * The flow is read → check → save, and the middle step is the whole point. An
 * AI model reads each screenshot; this component puts every row it read next
 * to the screenshot it came from, marks anything that did not add up, and
 * saves only what a person ticks. A misread digit is caught here or not at all.
 */

interface Shot {
  id: string;
  name: string;
  url: string;
  file: Blob;
  /** `removed` keeps its place, so every row's reference to screenshot #n stays right. */
  state: 'waiting' | 'reading' | 'read' | 'failed' | 'removed';
  error?: string;
  rows?: ReviewRow[];
}

interface Edit {
  amount?: string;
  direction?: TxnDirection;
  txnDate?: string;
  time?: string;
  counterpartyName?: string;
  description?: string;
}

/** Under Vercel's 4.5 MB request limit, with room for the form fields. */
const MAX_UPLOAD = 4_000_000;

/**
 * One image as the model should see it: whole when it fits, otherwise cut into
 * overlapping tiles by `planSlices`. Each tile becomes its own screenshot in the
 * list, so the thumbnail shows exactly what was read.
 */
async function splitForReading(file: Blob, name: string): Promise<Array<{ blob: Blob; name: string }>> {
  const bitmap = await createImageBitmap(file);
  const plan = planSlices(bitmap.width, bitmap.height);
  if (plan.slices.length === 1 && plan.scale === 1 && file.size <= MAX_UPLOAD) {
    bitmap.close();
    return [{ blob: file, name }];
  }
  const parts: Array<{ blob: Blob; name: string }> = [];
  for (const [k, slice] of plan.slices.entries()) {
    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = slice.height;
    canvas
      .getContext('2d')!
      .drawImage(bitmap, 0, slice.top / plan.scale, bitmap.width, slice.height / plan.scale, 0, 0, plan.width, slice.height);
    const toBlob = (type: string, quality?: number) =>
      new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not prepare the image.'))), type, quality),
      );
    // PNG keeps small digits crisp; JPEG only if PNG would still be too big.
    const png = await toBlob('image/png');
    const blob = png.size <= MAX_UPLOAD ? png : await toBlob('image/jpeg', 0.92);
    parts.push({ blob, name: plan.slices.length === 1 ? name : `${name} (${k + 1}/${plan.slices.length})` });
  }
  bitmap.close();
  return parts;
}

/**
 * A response body as JSON, even when it is not. Vercel answers an oversized
 * upload or a timed-out function with an HTML page, and `res.json()` on that
 * surfaced as "Unexpected token '<'" — true, and useless to the person reading.
 */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    if (res.status === 413) return { ok: false, error: 'That image is too large to upload.' };
    if (res.status === 504 || res.status === 502) {
      return { ok: false, error: 'Reading took too long. Try again, or take a shorter screenshot.' };
    }
    return { ok: false, error: `The server answered ${res.status} without a readable response.` };
  }
}

/** Screenshots read at once. Each is a paid request; three keeps a batch moving without a burst. */
const READ_CONCURRENCY = 3;

const RELEASED_BY_EDIT: Record<keyof Edit, RowIssue[]> = {
  amount: ['amount_mismatch', 'no_amount'],
  direction: ['direction_mismatch'],
  txnDate: ['no_datetime', 'bad_datetime', 'future_date'],
  time: [],
  counterpartyName: ['readings_differ'],
  description: ['readings_differ'],
};
const INFORMATIONAL: RowIssue[] = ['cut_off', 'readings_differ'];

export function ScreenshotImporter({
  accounts,
  configured,
}: {
  accounts: FinancialAccount[];
  /** Whether the server holds an ANTHROPIC_API_KEY — said up front, not after an upload. */
  configured: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const preferred = accounts.find((a) => a.currency === 'VND') ?? accounts[0];
  const [accountId, setAccountId] = useState(preferred?.id ?? '');
  const account = accounts.find((a) => a.id === accountId);
  const [shots, setShots] = useState<Shot[]>([]);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'brand' | 'outflow'; title: string; body: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const addFiles = async (list: FileList | File[]) => {
    // Copied before the first await: the file input is cleared as soon as this
    // returns control, and a FileList read afterwards can be empty.
    const files = [...list].filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
    if (!files.length) return;
    setMessage(null);
    for (const file of files) {
      let parts: Array<{ blob: Blob; name: string }>;
      try {
        parts = await splitForReading(file, file.name || 'pasted screenshot');
      } catch {
        setMessage({ tone: 'outflow', title: `${file.name || 'That image'} could not be opened.`, body: '' });
        continue;
      }
      setShots((s) => [
        ...s,
        ...parts.map((p) => ({
          id: `${p.name}-${p.blob.size}-${Math.random().toString(36).slice(2, 8)}`,
          name: p.name,
          url: URL.createObjectURL(p.blob),
          file: p.blob,
          state: 'waiting' as const,
        })),
      ]);
    }
  };

  const rows = useMemo(
    () => mergeReviewRows(shots.flatMap((s) => (s.state === 'removed' ? [] : (s.rows ?? [])))),
    [shots],
  );

  /** What a row is after the person's corrections, and what still stands in its way. */
  const effective = (r: ReviewRow) => {
    const e = edits[r.key] ?? {};
    let amountMinor = r.amountMinor;
    let amountOk = true;
    if (e.amount !== undefined) {
      // In the row's own currency. Parsing an edit in the account's currency
      // and showing the stored value in minor units made a corrected $12.50
      // into $1,250.00.
      const major = parseAmount(e.amount, { currency: r.currency });
      amountOk = major !== null && major > 0;
      amountMinor = amountOk ? toMinor(Math.abs(major!), r.currency) : null;
    }
    let txnDate = r.txnDate;
    let dateOk = true;
    if (e.txnDate !== undefined) {
      const [y, m, d] = e.txnDate.split('-');
      dateOk = Boolean(parseScreenDateTime(`${d}/${m}/${y}`));
      txnDate = dateOk ? e.txnDate : null;
    }
    const released = new Set<RowIssue>();
    for (const [field, value] of Object.entries(e) as Array<[keyof Edit, unknown]>) {
      if (value !== undefined) for (const i of RELEASED_BY_EDIT[field]) released.add(i);
    }
    let time = r.time;
    let timeOk = true;
    if (e.time !== undefined) {
      const typed = normaliseTime(e.time);
      timeOk = typed !== undefined;
      time = typed ?? null;
    }
    const issues = r.issues.filter((i) => !released.has(i));
    if (!amountOk) issues.push('no_amount');
    if (!dateOk || !timeOk) issues.push('bad_datetime');
    // Saving this row used to send the ACCOUNT's currency with it, so a USD
    // figure read into a VND account was stored as that many dong, and the
    // server's currency check compared the account with itself.
    if (account && r.currency !== account.currency && !issues.includes('currency_mismatch')) {
      issues.push('currency_mismatch');
    }
    const blockingIssues = issues.filter((i) => !INFORMATIONAL.includes(i));
    return {
      amountMinor,
      direction: e.direction ?? r.direction,
      txnDate,
      time,
      counterpartyName: e.counterpartyName ?? r.counterpartyName,
      description: e.description ?? r.description,
      issues,
      blocked: blockingIssues.length > 0,
      edited: Object.values(e).some((v) => v !== undefined),
    };
  };

  const isPicked = (r: ReviewRow) => (picked[r.key] ?? true) && !effective(r).blocked;
  const selected = rows.filter(isPicked);
  const totals = selected.reduce(
    (t, r) => {
      const e = effective(r);
      if (e.amountMinor) t[e.direction] += e.amountMinor;
      return t;
    },
    { inflow: 0, outflow: 0 } as Record<TxnDirection, number>,
  );

  async function readAll() {
    if (!accountId) return;
    setBusy(true);
    setMessage(null);

    // Positions are taken now, before anything changes, because every row
    // refers to its screenshot by position.
    const queue = shots
      .map((shot, index) => ({ shot, index }))
      .filter(({ shot }) => shot.state === 'waiting' || shot.state === 'failed');

    const readOne = async ({ shot, index }: { shot: Shot; index: number }) => {
      setShots((s) => s.map((x) => (x.id === shot.id ? { ...x, state: 'reading', error: undefined } : x)));
      try {
        const body = new FormData();
        body.append('image', shot.file, shot.name);
        body.append('accountId', accountId);
        body.append('index', String(index));
        const res = await fetch('/api/import/screenshot', { method: 'POST', body });
        const json = (await readJson(res)) as {
          ok: boolean;
          error?: string;
          rows?: ReviewRow[];
          screen?: { isTransactionList: boolean };
        };
        if (!json.ok) throw new Error(json.error ?? 'Could not read this screenshot.');
        const note =
          json.screen && !json.screen.isTransactionList ? 'This does not look like a list of transactions.' : undefined;
        setShots((s) => s.map((x) => (x.id === shot.id ? { ...x, state: 'read', rows: json.rows ?? [], error: note } : x)));
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Could not read this screenshot.';
        setShots((s) => s.map((x) => (x.id === shot.id ? { ...x, state: 'failed', error } : x)));
      }
    };

    // One at a time made a batch of ten screenshots a ten-minute wait.
    await Promise.all(
      Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) await readOne(next);
      }),
    );
    setBusy(false);
  }

  async function save() {
    if (!account || selected.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const payload = {
        accountId: account.id,
        images: shots.filter((s) => s.state === 'read').map((s) => s.name),
        rows: selected.map((r) => {
          const e = effective(r);
          return {
            txnDate: e.txnDate!,
            time: e.time,
            amountMinor: e.amountMinor!,
            currency: r.currency,
            direction: e.direction,
            counterpartyName: e.counterpartyName,
            counterpartyBank: r.counterpartyBank,
            counterpartyAccount: r.counterpartyAccount,
            description: e.description,
            reference: r.reference,
            transferType: r.transferType,
            statusText: r.statusText,
            postedScreen: r.postedScreen,
            readBy: r.readBy ?? null,
            edited: e.edited,
            original: e.edited
              ? {
                  amount_text: r.amountText,
                  amount_minor: r.amountMinor,
                  direction: r.direction,
                  datetime_text: r.datetimeText,
                  counterparty_name: r.counterpartyName,
                  description: r.description,
                }
              : null,
          };
        }),
      };
      const res = await fetch('/api/import/screenshot/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = (await readJson(res)) as {
        ok: boolean;
        error?: string;
        refusals?: string[];
        inserted?: number;
        skipped?: number;
        flaggedAsPossibleDuplicate?: number;
      };
      if (!json.ok) {
        setMessage({ tone: 'outflow', title: json.error ?? 'Nothing was saved.', body: (json.refusals ?? []).join(' ') });
        return;
      }
      setMessage({
        tone: 'brand',
        title: `${json.inserted} transaction${json.inserted === 1 ? '' : 's'} added to ${account.name}`,
        body:
          `${json.skipped ? `${json.skipped} were already there and were not added again. ` : ''}` +
          `${json.flaggedAsPossibleDuplicate ? `${json.flaggedAsPossibleDuplicate} look like duplicates of rows from another source and are waiting on the Reconcile page.` : ''}`,
      });
      shots.forEach((s) => URL.revokeObjectURL(s.url));
      setShots([]);
      setEdits({});
      setPicked({});
      startTransition(() => router.refresh());
    } catch (err) {
      setMessage({ tone: 'outflow', title: 'Nothing was saved.', body: err instanceof Error ? err.message : '' });
    } finally {
      setBusy(false);
    }
  }

  const edit = (key: string, patch: Edit) => setEdits((e) => ({ ...e, [key]: { ...e[key], ...patch } }));
  // A failed screenshot is reported, not a lock on the rest: it can be retried
  // or removed, and the rows already read can still be saved.
  const toRead = shots.filter((s) => s.state === 'waiting' || s.state === 'failed').length;
  const inFlight = shots.some((s) => s.state === 'waiting' || s.state === 'reading');

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-[560px]">
          <h3 className="text-[15px] font-semibold">From screenshots</h3>
          <p className="muted mt-1 text-[13px] leading-relaxed">
            Screenshots of the VietinBank app — transfer lists or account history. An AI model reads
            them; you check every row against the picture before anything is saved. Overlapping
            screenshots of one long list are fine: a transaction that appears twice is kept once.
          </p>
        </div>
        <label className="block">
          <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">Into account</span>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={rows.length > 0}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.currency}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!configured && (
        <div className="mt-4">
          <Callout tone="warn" title="Not set up yet">
            Reading screenshots needs <code>ANTHROPIC_API_KEY</code> in the deployment settings.
            Statement files can be imported above in the meantime.
          </Callout>
        </div>
      )}

      <div
        className="mt-4 rounded-lg border border-dashed border-[var(--line)] p-4 text-center"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }}
        onPaste={(e) => addFiles(e.clipboardData.files)}
        tabIndex={0}
      >
        <p className="muted text-[13px]">Drop screenshots here, paste one, or</p>
        <button type="button" className={`${buttonClass('secondary')} mt-2`} onClick={() => input.current?.click()}>
          Choose images
        </button>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {shots.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-3">
          {shots.map((s, i) =>
            s.state === 'removed' ? null : (
            <figure key={s.id} className="w-[112px] text-[11px]">
              <a href={s.url} target="_blank" rel="noreferrer" title="Open full size">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.url} alt={`Screenshot ${i + 1}`} className="h-[180px] w-full rounded-md object-cover object-top" />
              </a>
              <figcaption className="mt-1">
                <strong>#{i + 1}</strong>{' '}
                <span className="faint">
                  {s.state === 'waiting' && 'not read yet'}
                  {s.state === 'reading' && 'reading…'}
                  {s.state === 'read' && `${s.rows?.length ?? 0} rows`}
                  {s.state === 'failed' && 'failed'}
                </span>
                {s.error && (
                  <span className="block" style={{ color: s.state === 'failed' ? 'var(--outflow)' : 'var(--warn)' }}>
                    {s.error}
                  </span>
                )}
                {s.state !== 'reading' && (
                  <button
                    type="button"
                    className="faint block underline underline-offset-2"
                    onClick={() => setShots((all) => all.map((x) => (x.id === s.id ? { ...x, state: 'removed' } : x)))}
                  >
                    Remove
                  </button>
                )}
              </figcaption>
            </figure>
            ),
          )}
        </div>
      )}

      {toRead > 0 && (
        <button type="button" disabled={busy || !accountId || !configured} className={`${buttonClass('primary')} mt-4`} onClick={readAll}>
          {busy ? 'Reading…' : `Read ${toRead} screenshot${toRead === 1 ? '' : 's'}`}
        </button>
      )}

      {rows.length > 0 && (
        <>
          <p className="mt-5 text-[12.5px]" style={{ color: 'var(--warn)' }}>
            Check every amount against the screenshot. The reading is done by an AI model and can
            be wrong; a row with a problem is left out until you fix it.
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="faint text-left text-[11px] uppercase tracking-wide">
                  <th className="py-2 pr-2">Save</th>
                  <th className="pr-2">Date · time</th>
                  <th className="pr-2 text-right">Amount</th>
                  <th className="pr-2">Other party</th>
                  <th className="pr-2">Description</th>
                  <th className="pr-2">From</th>
                  <th>Check</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--line)]">
                {rows.map((r) => {
                  const e = effective(r);
                  const currency = r.currency;
                  return (
                    <tr key={r.key} className="align-top" style={{ opacity: e.blocked ? 0.75 : 1 }}>
                      <td className="py-2 pr-2">
                        <input
                          type="checkbox"
                          checked={isPicked(r)}
                          disabled={e.blocked}
                          onChange={(ev) => setPicked((p) => ({ ...p, [r.key]: ev.target.checked }))}
                          aria-label="Save this row"
                        />
                      </td>
                      <td className="pr-2">
                        <input
                          type="date"
                          value={edits[r.key]?.txnDate ?? r.txnDate ?? ''}
                          onChange={(ev) => edit(r.key, { txnDate: ev.target.value })}
                          className="w-[132px]"
                        />
                        <input
                          value={edits[r.key]?.time ?? r.time ?? ''}
                          onChange={(ev) => edit(r.key, { time: ev.target.value })}
                          placeholder="hh:mm:ss"
                          className="mt-1 w-[132px]"
                        />
                      </td>
                      <td className="pr-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            className="faint w-5 text-[14px]"
                            title="Switch money in / money out"
                            onClick={() => edit(r.key, { direction: e.direction === 'inflow' ? 'outflow' : 'inflow' })}
                          >
                            {e.direction === 'inflow' ? '+' : '−'}
                          </button>
                          <input
                            value={edits[r.key]?.amount ?? (r.amountMinor !== null ? String(toMajor(r.amountMinor, r.currency)) : '')}
                            onChange={(ev) => edit(r.key, { amount: ev.target.value })}
                            inputMode="decimal"
                            className="tabular w-[120px] text-right"
                          />
                        </div>
                        <div className="faint mt-1">printed: {r.amountText}</div>
                        {e.amountMinor !== null && (
                          <div className="tabular mt-0.5 font-medium">{formatMoney(e.amountMinor, currency)}</div>
                        )}
                      </td>
                      <td className="pr-2">
                        <input
                          value={edits[r.key]?.counterpartyName ?? r.counterpartyName ?? ''}
                          onChange={(ev) => edit(r.key, { counterpartyName: ev.target.value })}
                          className="w-[220px]"
                        />
                        <div className="faint mt-1">
                          {[r.counterpartyBank, r.counterpartyAccount].filter(Boolean).join(' · ')}
                        </div>
                      </td>
                      <td className="pr-2">
                        <input
                          value={edits[r.key]?.description ?? r.description ?? ''}
                          onChange={(ev) => edit(r.key, { description: ev.target.value })}
                          className="w-[200px]"
                        />
                        <div className="faint mt-1">
                          {[r.transferType, r.reference && `#${r.reference}`, r.statusText].filter(Boolean).join(' · ')}
                        </div>
                      </td>
                      <td className="pr-2">
                        {r.images.map((n) => (
                          <a key={n} href={shots[n]?.url} target="_blank" rel="noreferrer" className="mr-1 underline underline-offset-2">
                            #{n + 1}
                          </a>
                        ))}
                      </td>
                      <td className="max-w-[260px]">
                        {e.issues.length === 0 ? (
                          <span style={{ color: 'var(--inflow)' }}>OK</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {e.issues.map((i) => (
                              <li key={i} style={{ color: INFORMATIONAL.includes(i) ? 'var(--text-faint)' : 'var(--outflow)' }}>
                                {ISSUE_TEXT[i]}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-[var(--line)] pt-4">
            <p className="text-[13px]">
              <strong>{selected.length}</strong> of {rows.length} rows ·{' '}
              <span className="tabular">money out {formatMoney(totals.outflow, account?.currency ?? 'VND')}</span>
              {totals.inflow > 0 && (
                <span className="tabular"> · money in {formatMoney(totals.inflow, account?.currency ?? 'VND')}</span>
              )}
            </p>
            <button
              type="button"
              disabled={busy || pending || selected.length === 0 || inFlight}
              className={buttonClass('primary')}
              onClick={save}
            >
              {busy ? 'Saving…' : `Save ${selected.length} to ${account?.name ?? 'the account'}`}
            </button>
          </div>
        </>
      )}

      {message && (
        <div className="mt-4">
          <Callout tone={message.tone} title={message.title}>
            {message.body}
          </Callout>
        </div>
      )}
    </div>
  );
}
