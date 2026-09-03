'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui';
import { categoryLabel } from '@/lib/categorize';

/**
 * Record what is owed, in either direction - Spec sections 17 and 18.
 *
 * One form for both because they are the same shape. The wording changes so a
 * person is never guessing which way round they are entering something: money
 * IN is an invoice somebody owes AHN, money OUT is a bill AHN owes.
 */
type Cadence = 'monthly' | 'quarterly' | 'annual';

export function ObligationEditor({
  categories,
  projects,
}: {
  categories: string[];
  projects: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [direction, setDirection] = useState<'inflow' | 'outflow'>('outflow');
  const [counterparty, setCounterparty] = useState('');
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState('');
  const [contracted, setContracted] = useState('');
  const [category, setCategory] = useState('');
  const [projectId, setProjectId] = useState('');
  const [issuedOn, setIssuedOn] = useState('');
  const [dueOn, setDueOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurrence, setRecurrence] = useState<Cadence | null>(null);

  const owed = direction === 'inflow';

  async function submit() {
    const minor = toMinor(amount);
    if (!counterparty.trim()) return setError(owed ? 'Who owes it?' : 'Who is it owed to?');
    if (minor === null) return setError('Enter the amount.');

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/obligations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          direction,
          counterpartyName: counterparty.trim(),
          description: description.trim() || null,
          reference: reference.trim() || null,
          category: category || null,
          projectId: projectId || null,
          amountMinor: minor,
          contractedAmountMinor: toMinor(contracted),
          currency: 'USD',
          issuedOn: issuedOn || null,
          dueOn,
          isRecurring,
          recurrence,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!json.ok) return setError(json.error ?? 'Could not save.');
      setOpen(false);
      setCounterparty('');
      setDescription('');
      setReference('');
      setAmount('');
      setContracted('');
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('primary')}>
        Record what is owed
      </button>
    );
  }

  return (
    <div className="card w-full max-w-[640px] p-5">
      <p className="mb-3 text-[13px] font-semibold">
        {owed ? 'Money owed to AHN' : 'Money AHN owes'}
      </p>

      <div className="mb-4 flex flex-wrap gap-2">
        <Toggle active={!owed} onClick={() => setDirection('outflow')}>
          A bill or commitment
        </Toggle>
        <Toggle active={owed} onClick={() => setDirection('inflow')}>
          An invoice to a client
        </Toggle>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={owed ? 'Who owes it' : 'Who it is owed to'}>
          <input
            value={counterparty}
            onChange={(e) => setCounterparty(e.target.value)}
            placeholder={owed ? 'Acme Corp' : 'Gusto'}
            className="w-full"
          />
        </Field>

        <Field label="What for">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={owed ? 'Website build, phase 2' : 'September payroll'}
            className="w-full"
          />
        </Field>

        <Field label="Amount (USD)">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="5850"
            className="w-full"
          />
        </Field>

        <Field
          label="Contracted total"
          hint="Only if this is part of a larger agreement — leave blank otherwise"
        >
          <input
            value={contracted}
            onChange={(e) => setContracted(e.target.value)}
            placeholder="Optional"
            className="w-full"
          />
        </Field>

        <Field label={owed ? 'Invoiced on' : 'Committed on'} hint="Optional">
          <input
            type="date"
            value={issuedOn}
            onChange={(e) => setIssuedOn(e.target.value)}
            className="w-full"
          />
        </Field>

        <Field label="Due">
          <input
            type="date"
            value={dueOn}
            onChange={(e) => setDueOn(e.target.value)}
            className="w-full"
          />
        </Field>

        <Field label="Reference" hint="Invoice or bill number">
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="INV-001"
            className="w-full"
          />
        </Field>

        <Field label="Category">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full"
          >
            <option value="">—</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
        </Field>

        {projects.length > 0 && (
          <Field label="Project">
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full"
            >
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field
          label="Repeats"
          hint={
            recurrence
              ? 'The next three months are created automatically'
              : 'Payroll, retainers, rent, taxes'
          }
        >
          {/*
            A cadence, not a checkbox. "It recurs" says a thing repeats without
            saying when, which is not enough to generate anything — and a
            commitment nobody scheduled must not appear in the forecast.
          */}
          <select
            value={recurrence ?? ''}
            onChange={(e) => {
              const next = e.target.value === '' ? null : (e.target.value as Cadence);
              setRecurrence(next);
              setIsRecurring(next !== null);
            }}
            className="mt-1 w-full"
          >
            <option value="">One off</option>
            <option value="monthly">Every month</option>
            <option value="quarterly">Every quarter</option>
            <option value="annual">Every year</option>
          </select>
        </Field>
      </div>

      {error && (
        <p className="mt-3 text-[12px]" style={{ color: 'var(--outflow)' }}>
          {error}
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy || pending}
          className={buttonClass('primary')}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busy}
          className={buttonClass('secondary')}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Mark one obligation settled, or void it. */
export function SettleButton({
  id,
  suggestedTxnId,
  canEdit,
}: {
  id: string;
  suggestedTxnId?: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canEdit) return null;

  async function set(status: 'settled' | 'void') {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/obligations', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, status, settledTxnId: suggestedTxnId ?? null }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!json.ok) return setError(json.error ?? 'Failed.');
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => set('settled')}
        disabled={busy || pending}
        className="text-[12px] underline underline-offset-2"
      >
        {busy ? '…' : 'Mark settled'}
      </button>
      {error && (
        <span className="text-[11px]" style={{ color: 'var(--outflow)' }}>
          {error}
        </span>
      )}
    </span>
  );
}

function Toggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full px-3 py-1.5 text-[12.5px] font-medium transition-colors"
      style={{
        background: active ? 'var(--brand-soft)' : 'var(--surface-sunk)',
        color: active ? 'var(--brand)' : 'var(--text-muted)',
      }}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="faint block text-[11px] font-semibold uppercase tracking-[0.05em]">
        {label}
      </span>
      <span className="mt-1 block">{children}</span>
      {hint && <span className="faint mt-1 block text-[11px]">{hint}</span>}
    </label>
  );
}

function toMinor(value: string): number | null {
  const cleaned = value.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}
