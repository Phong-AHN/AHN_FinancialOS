'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { formatMoney } from '@/lib/money';
import { buttonClass } from '@/components/ui';

/**
 * Change what a budget is, in place - Spec section 19.
 *
 * Re-saving the same scope and period already replaced the amount, because the
 * create route upserts on (scope, scope_id, scope_key, period, starts_on). It
 * worked and nobody could tell: the only way to correct a number was to open
 * "New budget", reproduce the scope exactly from memory, and trust that the
 * unique key would catch it. Anyone who got one field wrong created a second
 * budget instead of fixing the first.
 *
 * ONLY THE AMOUNT IS EDITABLE HERE. The scope and the period are the row's
 * identity — a budget for marketing in September that becomes a budget for
 * payroll in October is not an edit, it is a different budget, and pretending
 * otherwise would silently rewrite whatever history had already been reported
 * against it.
 */
export function BudgetAmount({
  budgetId,
  name,
  scope,
  scopeId,
  scopeKey,
  period,
  startsOn,
  amountMinor,
  canEdit,
}: {
  budgetId: string;
  name: string;
  scope: string;
  scopeId: string | null;
  scopeKey: string | null;
  period: string;
  startsOn: string;
  amountMinor: number;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState(String(amountMinor / 100));

  if (!canEdit) return <>{formatMoney(amountMinor)}</>;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="tabular underline decoration-dotted underline-offset-4"
        title="Change this amount"
      >
        {formatMoney(amountMinor)}
      </button>
    );
  }

  async function save() {
    const major = Number(value.replace(/[$,\s]/g, ''));
    if (!Number.isFinite(major) || major < 0) {
      setError('Enter an amount.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // The same create route: it upserts on the natural key, so sending the
      // row's own scope and period back is an edit by construction. No second
      // endpoint means no second set of rules about what a budget may be.
      const res = await fetch('/api/budgets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          scope,
          scopeId: scopeId ?? undefined,
          scopeKey: scopeKey ?? undefined,
          period,
          startsOn,
          amountMinor: Math.round(major * 100),
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!json.ok) {
        setError(json.error ?? 'Could not save that.');
        return;
      }
      setOpen(false);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/budgets?id=${budgetId}`, { method: 'DELETE' });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!json.ok) {
        setError(json.error ?? 'Could not remove that.');
        return;
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        inputMode="decimal"
        autoFocus
        className="tabular w-28 text-right"
      />
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={save}
          disabled={busy || pending}
          className={buttonClass('primary')}
        >
          {busy ? '…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setValue(String(amountMinor / 100));
            setError(null);
          }}
          disabled={busy}
          className={buttonClass('secondary')}
        >
          Cancel
        </button>
      </div>
      <button
        type="button"
        onClick={remove}
        disabled={busy || pending}
        className="faint text-[11px] underline underline-offset-2"
      >
        Remove this budget
      </button>
      {error && (
        <span className="text-[11px]" style={{ color: 'var(--outflow)' }}>
          {error}
        </span>
      )}
    </div>
  );
}
