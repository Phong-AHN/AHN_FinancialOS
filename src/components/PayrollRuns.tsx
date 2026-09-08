'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card, SectionHeader, buttonClass } from '@/components/ui';
import { formatMoney } from '@/lib/money';

interface Person {
  id: string;
  name: string;
  email: string | null;
}

interface Run {
  id: string;
  name: string;
  status: string;
  currency: string;
  created_by: string | null;
  approved_by: string | null;
}

/**
 * Prepare, approve and send a payroll run - Spec section 7.
 *
 * No permission logic lives here. The database decides who may send, and
 * refuses a run approved by the person who prepared it (migration 0036). This
 * component's job is to make the amount and the recipients impossible to
 * misread BEFORE the click, and to make the click itself deliberate.
 */
export function PayrollRuns({
  people,
  runs,
  currentUserId,
}: {
  people: Person[];
  runs: Run[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  /** person id -> amount typed in major units. */
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [confirmWord, setConfirmWord] = useState('');

  const lines = people
    .map((p) => ({ person: p, major: Number((amounts[p.id] ?? '').replace(/[$,\s]/g, '')) }))
    .filter((l) => Number.isFinite(l.major) && l.major > 0);

  const totalMinor = lines.reduce((sum, l) => sum + Math.round(l.major * 100), 0);

  const draft = runs.find((r) => r.status === 'draft');
  const approved = runs.find((r) => r.status === 'approved');

  async function call(path: string, body: unknown): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method: path.endsWith('/payroll') && body && 'action' in (body as object) ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!json.ok) {
        const refusals = json.refusals as Array<{ line: string; reason: string }> | undefined;
        setError(
          refusals?.length
            ? refusals.map((r) => `${r.line}: ${r.reason}`).join('\n')
            : String(json.error ?? 'That did not work.'),
        );
        return null;
      }
      startTransition(() => router.refresh());
      return json;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionHeader
        title="Prepare a run"
        subtitle="Type what each person is owed. Blank means they are not in this run."
      />

      <div className="flex flex-wrap items-end gap-3">
        <label className="block flex-1" style={{ minWidth: 180 }}>
          <span className="faint block text-[11px] font-semibold uppercase tracking-[0.05em]">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="August payroll"
            className="mt-1 w-full"
          />
        </label>
        <label className="block">
          <span className="faint block text-[11px] font-semibold uppercase tracking-[0.05em]">Period from</span>
          <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className="mt-1" />
        </label>
        <label className="block">
          <span className="faint block text-[11px] font-semibold uppercase tracking-[0.05em]">to</span>
          <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="mt-1" />
        </label>
      </div>

      {people.length === 0 ? (
        <p className="muted mt-4 text-[13px]">
          Nobody has an email address on file. VEEM pays to an email — add one on People &amp; time.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-[var(--line)]">
          {people.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-[13px]">{p.name}</p>
                <p className="faint text-[11px]">{p.email}</p>
              </div>
              <input
                value={amounts[p.id] ?? ''}
                onChange={(e) => setAmounts({ ...amounts, [p.id]: e.target.value })}
                placeholder="0.00"
                inputMode="decimal"
                className="tabular w-28 text-right"
              />
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <p className="text-[13px]">
          <strong>{lines.length}</strong> {lines.length === 1 ? 'person' : 'people'} ·{' '}
          <strong className="tabular">{formatMoney(totalMinor)}</strong>
        </p>
        <button
          type="button"
          disabled={busy || pending || lines.length === 0 || !name || !periodStart || !periodEnd}
          className={buttonClass('secondary')}
          onClick={() =>
            call('/api/payroll', {
              name,
              periodStart,
              periodEnd,
              currency: 'USD',
              lines: lines.map((l) => ({
                personId: l.person.id,
                payeeName: l.person.name,
                payeeEmail: l.person.email,
                payeeCountry: 'PH',
                amountMinor: Math.round(l.major * 100),
              })),
            })
          }
        >
          {busy ? 'Working…' : 'Prepare this run'}
        </button>
      </div>

      {draft && (
        <div className="mt-5 border-t border-[var(--line)] pt-4">
          <p className="text-[13px]">
            <strong>{draft.name}</strong> is a draft awaiting approval.
          </p>
          <p className="faint mt-1 text-[11px]">
            {draft.created_by === currentUserId
              ? 'You prepared this run, so somebody else has to approve it. The database refuses your own approval.'
              : 'You did not prepare this run, so you may approve it.'}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy || pending || draft.created_by === currentUserId}
              className={buttonClass('primary')}
              onClick={() => call('/api/payroll', { runId: draft.id, action: 'approve' })}
            >
              Approve
            </button>
            <button
              type="button"
              disabled={busy || pending}
              className={buttonClass('secondary')}
              onClick={() => call('/api/payroll', { runId: draft.id, action: 'cancel' })}
            >
              Cancel it
            </button>
          </div>
        </div>
      )}

      {approved && (
        <div className="mt-5 border-t border-[var(--line)] pt-4">
          <p className="text-[13px]">
            <strong>{approved.name}</strong> is approved and ready to send.
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || pending}
              className={buttonClass('secondary')}
              onClick={async () => {
                const json = await call('/api/payroll/send', { runId: approved.id });
                if (json) setPreview(JSON.stringify(json.preview, null, 2));
              }}
            >
              Preview — sends nothing
            </button>

            {/* Typing the word is the last gate. A boolean can be set by a
                stray default or a replayed body; the word cannot. */}
            <input
              value={confirmWord}
              onChange={(e) => setConfirmWord(e.target.value)}
              placeholder="type SEND"
              className="w-32"
            />
            <button
              type="button"
              disabled={busy || pending || confirmWord !== 'SEND'}
              className={buttonClass('danger')}
              onClick={() => {
                setConfirmWord('');
                void call('/api/payroll/send', { runId: approved.id, confirm: 'SEND' });
              }}
            >
              Send money
            </button>
          </div>
        </div>
      )}

      {preview && (
        <pre
          className="mt-4 overflow-x-auto rounded-lg p-3 text-[11px]"
          style={{ background: 'var(--surface-sunk)' }}
        >
          {preview}
        </pre>
      )}

      {error && (
        <p className="mt-3 whitespace-pre-line text-[12px]" style={{ color: 'var(--outflow)' }}>
          {error}
        </p>
      )}
    </Card>
  );
}
