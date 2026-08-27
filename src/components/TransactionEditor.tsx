'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui';
import { CATEGORY_LABELS } from '@/lib/categorize';
import type { ReconStatus } from '@/lib/types';

export interface EditableTransaction {
  id: string;
  category: string | null;
  subcategory: string | null;
  notes: string | null;
  is_internal_transfer: boolean;
  is_subscription: boolean;
  is_recurring: boolean;
  reconciliation_status: ReconStatus;
}

const STATUS_OPTIONS: Array<{ value: ReconStatus; label: string; help: string }> = [
  { value: 'unreconciled', label: 'Unreconciled', help: 'Not reviewed yet. Counts toward totals.' },
  { value: 'reconciled', label: 'Reconciled', help: 'Confirmed against the bank. Counts toward totals.' },
  { value: 'matched', label: 'Matched', help: 'Matched to another source. Counts toward totals.' },
  {
    value: 'possible_duplicate',
    label: 'Possible duplicate',
    help: 'Held OUT of cash, burn and revenue until confirmed.',
  },
  {
    value: 'duplicate_ignored',
    label: 'Confirmed duplicate',
    help: 'Permanently excluded from every total.',
  },
];

/**
 * Manual correction form - Spec section 3 ("allowing manual corrections") and
 * section 24 (audit trail).
 *
 * The reason field is offered rather than required: forcing a justification on
 * every typo fix trains people to type "x", which is worse than an empty field.
 */
export function TransactionEditor({
  transaction,
  canEdit,
}: {
  transaction: EditableTransaction;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [form, setForm] = useState(transaction);
  const [reason, setReason] = useState('');

  const dirty =
    form.category !== transaction.category ||
    form.subcategory !== transaction.subcategory ||
    form.notes !== transaction.notes ||
    form.is_internal_transfer !== transaction.is_internal_transfer ||
    form.is_subscription !== transaction.is_subscription ||
    form.is_recurring !== transaction.is_recurring ||
    form.reconciliation_status !== transaction.reconciliation_status;

  async function save() {
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch(`/api/transactions/${transaction.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          category: form.category,
          subcategory: form.subcategory,
          notes: form.notes,
          is_internal_transfer: form.is_internal_transfer,
          is_subscription: form.is_subscription,
          is_recurring: form.is_recurring,
          reconciliation_status: form.reconciliation_status,
          reason: reason.trim() || null,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; audited?: number; error?: string };

      if (!res.ok) {
        setResult({ ok: false, message: json.error ?? 'Save failed.' });
      } else {
        setResult({
          ok: true,
          message:
            json.audited === 0
              ? 'Nothing changed.'
              : `Saved. ${json.audited} change${json.audited === 1 ? '' : 's'} written to the audit log.`,
        });
        setReason('');
        startTransition(() => router.refresh());
      }
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : 'Save failed.' });
    } finally {
      setSaving(false);
    }
  }

  const statusHelp = STATUS_OPTIONS.find((s) => s.value === form.reconciliation_status)?.help;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">Category</span>
          <select
            disabled={!canEdit}
            value={form.category ?? ''}
            onChange={(e) => setForm({ ...form, category: e.target.value || null })}
          >
            <option value="">— none —</option>
            {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">Subcategory</span>
          <input
            type="text"
            disabled={!canEdit}
            value={form.subcategory ?? ''}
            placeholder="e.g. google_workspace"
            onChange={(e) => setForm({ ...form, subcategory: e.target.value || null })}
          />
        </label>

        <label className="block md:col-span-2">
          <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">Notes</span>
          <textarea
            rows={2}
            disabled={!canEdit}
            value={form.notes ?? ''}
            onChange={(e) => setForm({ ...form, notes: e.target.value || null })}
          />
        </label>

        <label className="block">
          <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">
            Reconciliation status
          </span>
          <select
            disabled={!canEdit}
            value={form.reconciliation_status}
            onChange={(e) =>
              setForm({ ...form, reconciliation_status: e.target.value as ReconStatus })
            }
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          {statusHelp && <span className="faint mt-1 block text-[11.5px]">{statusHelp}</span>}
        </label>

        <label className="block">
          <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">
            Reason for the change (optional)
          </span>
          <input
            type="text"
            disabled={!canEdit}
            value={reason}
            placeholder="Recorded alongside the edit"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-5 text-[12.5px]">
        <Toggle
          label="Internal transfer"
          help="Excluded from revenue, expense and burn."
          checked={form.is_internal_transfer}
          disabled={!canEdit}
          onChange={(v) => setForm({ ...form, is_internal_transfer: v })}
        />
        <Toggle
          label="Subscription"
          help="Feeds the Phase-2 subscription intelligence."
          checked={form.is_subscription}
          disabled={!canEdit}
          onChange={(v) => setForm({ ...form, is_subscription: v })}
        />
        <Toggle
          label="Recurring"
          checked={form.is_recurring}
          disabled={!canEdit}
          onChange={(v) => setForm({ ...form, is_recurring: v })}
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          className={buttonClass('primary')}
          disabled={!canEdit || !dirty || saving || pending}
          onClick={save}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        {dirty && !saving && <span className="faint text-[12px]">Unsaved changes</span>}
        {result && (
          <span
            className="text-[12.5px]"
            style={{ color: result.ok ? 'var(--inflow)' : 'var(--outflow)' }}
          >
            {result.message}
          </span>
        )}
      </div>
    </div>
  );
}

function Toggle({
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-[var(--brand)]"
        style={{ width: 16, height: 16 }}
      />
      <span>
        <span className="font-medium">{label}</span>
        {help && <span className="faint block text-[11.5px]">{help}</span>}
      </span>
    </label>
  );
}
