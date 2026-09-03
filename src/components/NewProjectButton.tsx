'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui';
import type { BusinessUnit } from '@/lib/types';

/**
 * Create a project or an event.
 *
 * The contracted and budget figures are optional on purpose. Spec §12 asks for
 * them, and nothing in a bank feed can supply them — but forcing a number at
 * creation time gets a guess typed in, and a guessed contract value is worse
 * than a blank one, because every variance measured against it inherits the
 * guess without saying so.
 */
export function NewProjectButton({ units }: { units: BusinessUnit[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [kind, setKind] = useState<'project' | 'event'>('project');
  const [unitId, setUnitId] = useState('');
  const [clientName, setClientName] = useState('');
  const [service, setService] = useState('');
  const [contracted, setContracted] = useState('');
  const [budget, setBudget] = useState('');

  const services = units.find((u) => u.id === unitId)?.services ?? [];

  async function submit() {
    if (!name.trim()) {
      setError('A project needs a name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          kind,
          businessUnitId: unitId || null,
          clientName: clientName.trim() || null,
          service: service || null,
          // Entered in whole currency; stored in minor units, like every other
          // amount in the system.
          contractedRevenueMinor: toMinorOrNull(contracted),
          budgetExpenseMinor: toMinorOrNull(budget),
        }),
      });
      const json = (await res.json()) as { ok?: boolean; id?: string; error?: string };
      if (!json.ok) {
        setError(json.error ?? 'Could not create the project.');
        return;
      }
      setOpen(false);
      setName('');
      setClientName('');
      setContracted('');
      setBudget('');
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the project.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('primary')}>
        New project
      </button>
    );
  }

  return (
    <div className="card w-full max-w-[560px] p-5">
      <p className="mb-3 text-[13px] font-semibold">New project or event</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="AHN Summit 2026"
            className="w-full"
          />
        </Field>

        <Field label="Kind">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as 'project' | 'event')}
            className="w-full"
          >
            <option value="project">Project</option>
            <option value="event">Event</option>
          </select>
        </Field>

        <Field label="Business unit">
          <select value={unitId} onChange={(e) => setUnitId(e.target.value)} className="w-full">
            <option value="">—</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Service">
          <select
            value={service}
            onChange={(e) => setService(e.target.value)}
            disabled={services.length === 0}
            className="w-full"
          >
            <option value="">{services.length ? '—' : 'Pick a business unit first'}</option>
            {services.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Client">
          <input
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            placeholder="Optional"
            className="w-full"
          />
        </Field>

        <Field label="Contracted revenue" hint="Optional — leave blank if unknown">
          <input
            value={contracted}
            onChange={(e) => setContracted(e.target.value)}
            placeholder="USD"
            className="w-full"
          />
        </Field>

        <Field label="Expense budget" hint="Optional — leave blank if unknown">
          <input
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="USD"
            className="w-full"
          />
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
          {busy ? 'Creating…' : 'Create'}
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

/** Blank stays blank. An empty box means "unknown", never zero. */
function toMinorOrNull(value: string): number | null {
  const cleaned = value.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}
