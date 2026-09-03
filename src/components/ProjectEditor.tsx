'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui';

const STATUSES = ['planned', 'active', 'completed', 'cancelled'] as const;
type Status = (typeof STATUSES)[number];

const STATUS_LABELS: Record<Status, string> = {
  planned: 'Planned',
  active: 'Active',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/** Major units in, minor units out. Empty stays null — see below. */
function toMinorOrNull(raw: string): number | null | 'invalid' {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed.replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return 'invalid';
  return Math.round(n * 100);
}

/**
 * Correct a project after it exists - Spec sections 12, 14, 15.
 *
 * Projects were create-and-attribute only, so a typo, a finished project or a
 * contract value that arrived late all needed the database console — on the one
 * table AHN is about to fill in by hand for the first time.
 *
 * Empty means NULL here, never zero. Spec §12 wants contracted and invoiced
 * revenue; neither exists in a bank feed, and "nobody has told us" is a
 * different claim from "nothing was contracted". The placeholder says so.
 */
export function ProjectEditor({
  projectId,
  initial,
}: {
  projectId: string;
  initial: {
    name: string;
    status: Status;
    service: string | null;
    startsOn: string | null;
    endsOn: string | null;
    contractedRevenueMinor: number | null;
    invoicedRevenueMinor: number | null;
    budgetExpenseMinor: number | null;
    estimatedHours: number | null;
  };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const major = (m: number | null) => (m === null ? '' : String(m / 100));

  const [name, setName] = useState(initial.name);
  const [status, setStatus] = useState<Status>(initial.status);
  const [service, setService] = useState(initial.service ?? '');
  const [startsOn, setStartsOn] = useState(initial.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(initial.endsOn ?? '');
  const [contracted, setContracted] = useState(major(initial.contractedRevenueMinor));
  const [invoiced, setInvoiced] = useState(major(initial.invoicedRevenueMinor));
  const [budget, setBudget] = useState(major(initial.budgetExpenseMinor));
  const [hours, setHours] = useState(initial.estimatedHours === null ? '' : String(initial.estimatedHours));

  async function save() {
    const money: Record<string, number | null> = {};
    for (const [key, raw] of [
      ['contractedRevenueMinor', contracted],
      ['invoicedRevenueMinor', invoiced],
      ['budgetExpenseMinor', budget],
    ] as const) {
      const parsed = toMinorOrNull(raw);
      if (parsed === 'invalid') {
        setError('Amounts must be a number, or blank for "not known".');
        return;
      }
      money[key] = parsed;
    }

    const hoursValue = hours.trim() === '' ? null : Number(hours);
    if (hoursValue !== null && (!Number.isFinite(hoursValue) || hoursValue < 0)) {
      setError('Estimated hours must be a number, or blank.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          status,
          service: service.trim() === '' ? null : service.trim(),
          startsOn: startsOn === '' ? null : startsOn,
          endsOn: endsOn === '' ? null : endsOn,
          ...money,
          estimatedHours: hoursValue,
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

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('secondary')}>
        Edit project
      </button>
    );
  }

  const Field = ({
    label,
    children,
    hint,
  }: {
    label: string;
    children: React.ReactNode;
    hint?: string;
  }) => (
    <label className="block">
      <span className="faint block text-[11px] font-semibold uppercase tracking-[0.05em]">
        {label}
      </span>
      {children}
      {hint && <span className="faint mt-0.5 block text-[11px]">{hint}</span>}
    </label>
  );

  return (
    <div className="w-full">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full" />
        </Field>

        <Field label="Status" hint="Completed and cancelled drop out of the active roll-up">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as Status)}
            className="mt-1 w-full"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Service">
          <input
            value={service}
            onChange={(e) => setService(e.target.value)}
            placeholder="Sponsorship"
            className="mt-1 w-full"
          />
        </Field>

        <Field label="Starts">
          <input
            type="date"
            value={startsOn}
            onChange={(e) => setStartsOn(e.target.value)}
            className="mt-1 w-full"
          />
        </Field>

        <Field label="Ends">
          <input
            type="date"
            value={endsOn}
            onChange={(e) => setEndsOn(e.target.value)}
            className="mt-1 w-full"
          />
        </Field>

        <Field label="Estimated hours">
          <input
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            placeholder="not known"
            inputMode="decimal"
            className="mt-1 w-full"
          />
        </Field>

        <Field label="Contracted revenue" hint="Blank means nobody has told us">
          <input
            value={contracted}
            onChange={(e) => setContracted(e.target.value)}
            placeholder="not known"
            inputMode="decimal"
            className="mt-1 w-full"
          />
        </Field>

        <Field label="Invoiced revenue" hint="Blank means nobody has told us">
          <input
            value={invoiced}
            onChange={(e) => setInvoiced(e.target.value)}
            placeholder="not known"
            inputMode="decimal"
            className="mt-1 w-full"
          />
        </Field>

        <Field label="Expense budget" hint="Blank means nobody has told us">
          <input
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="not known"
            inputMode="decimal"
            className="mt-1 w-full"
          />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || pending}
          className={buttonClass('primary')}
        >
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={busy}
          className={buttonClass('secondary')}
        >
          Cancel
        </button>
        <span className="faint text-[11px]">
          Every change is audited. The business unit is not editable here — moving a project
          between units restates two units&rsquo; history.
        </span>
      </div>

      {error && (
        <p className="mt-2 text-[12px]" style={{ color: 'var(--outflow)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
