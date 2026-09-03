'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui';

interface PersonOption {
  id: string;
  name: string;
  kind: string;
}
interface ProjectOption {
  id: string;
  name: string;
  kind: string;
}

/**
 * Add a person, or log hours against a project - Spec section 13.
 *
 * Two small forms rather than one page of settings, because these are the two
 * things anyone actually does here. Rates are entered in whole currency and
 * stored in minor units, like every other amount in the system.
 */
export function TimeTracker({
  people,
  projects,
}: {
  people: PersonOption[];
  projects: ProjectOption[];
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <AddPerson />
      <LogTime people={people} projects={projects} />
    </div>
  );
}

function AddPerson() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [kind, setKind] = useState<'employee' | 'contractor'>('employee');
  const [basis, setBasis] = useState<'salaried' | 'hourly' | 'contractor_rate'>('salaried');
  const [rate, setRate] = useState('');
  const [annualHours, setAnnualHours] = useState('1880');

  const salaried = basis === 'salaried';

  async function submit() {
    const amount = toMinor(rate);
    if (!name.trim()) return setError('A person needs a name.');
    if (amount === null) return setError('That costing basis needs its rate.');

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/people', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          kind,
          basis,
          annualCostMinor: salaried ? amount : null,
          hourlyCostMinor: salaried ? null : amount,
          annualHours: Number(annualHours) || 1880,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!json.ok) return setError(json.error ?? 'Could not save.');
      setName('');
      setRate('');
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5">
      <p className="mb-1 text-[13px] font-semibold">Add a person</p>
      <p className="faint mb-4 text-[11.5px]">
        Use the <strong>loaded</strong> cost — salary plus employer taxes and benefits. A headline
        salary understates a real employee by roughly a fifth, and every project they touch
        inherits the error.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full" />
        </Field>
        <Field label="Kind">
          <select
            value={kind}
            onChange={(e) => {
              const next = e.target.value as 'employee' | 'contractor';
              setKind(next);
              setBasis(next === 'contractor' ? 'contractor_rate' : 'salaried');
            }}
            className="w-full"
          >
            <option value="employee">Employee</option>
            <option value="contractor">Contractor</option>
          </select>
        </Field>
        <Field label="Costing basis">
          <select
            value={basis}
            onChange={(e) => setBasis(e.target.value as typeof basis)}
            className="w-full"
          >
            <option value="salaried">Salaried — annual loaded cost</option>
            <option value="hourly">Hourly rate</option>
            <option value="contractor_rate">Contractor rate</option>
          </select>
        </Field>
        <Field label={salaried ? 'Annual loaded cost (USD)' : 'Rate per hour (USD)'}>
          <input
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder={salaried ? '120000' : '100'}
            className="w-full"
          />
        </Field>
        {salaried && (
          <Field
            label="Working hours a year"
            hint="1,880 is full-time after leave; 2,080 assumes none is taken"
          >
            <input
              value={annualHours}
              onChange={(e) => setAnnualHours(e.target.value)}
              className="w-full"
            />
          </Field>
        )}
      </div>

      {error && (
        <p className="mt-3 text-[12px]" style={{ color: 'var(--outflow)' }}>
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={busy || pending}
        className={`${buttonClass('primary')} mt-4`}
      >
        {busy ? 'Saving…' : 'Add person'}
      </button>
    </div>
  );
}

function LogTime({
  people,
  projects,
}: {
  people: PersonOption[];
  projects: ProjectOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [personId, setPersonId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [workDate, setWorkDate] = useState(new Date().toISOString().slice(0, 10));
  const [hours, setHours] = useState('');

  async function submit() {
    if (!personId || !projectId) return setError('Pick a person and a project.');
    const value = Number(hours);
    if (!Number.isFinite(value) || value <= 0 || value > 24) {
      return setError('Hours must be between 0 and 24.');
    }

    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch('/api/time-entries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ personId, projectId, workDate, hours: value }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!json.ok) return setError(json.error ?? 'Could not save.');
      setHours('');
      setDone(`Logged ${value}h on ${workDate}.`);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  const blocked = people.length === 0 || projects.length === 0;

  return (
    <div className="card p-5">
      <p className="mb-1 text-[13px] font-semibold">Log hours</p>
      <p className="faint mb-4 text-[11.5px]">
        One entry per person per project per day. Saving the same day again replaces it rather
        than adding to it.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Person">
          <select
            value={personId}
            onChange={(e) => setPersonId(e.target.value)}
            className="w-full"
            disabled={people.length === 0}
          >
            <option value="">{people.length ? '—' : 'Add someone first'}</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Project">
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-full"
            disabled={projects.length === 0}
          >
            <option value="">{projects.length ? '—' : 'Create a project first'}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.kind === 'event' ? ' (event)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Date">
          <input
            type="date"
            value={workDate}
            onChange={(e) => setWorkDate(e.target.value)}
            className="w-full"
          />
        </Field>
        <Field label="Hours">
          <input
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            placeholder="7.5"
            className="w-full"
          />
        </Field>
      </div>

      {error && (
        <p className="mt-3 text-[12px]" style={{ color: 'var(--outflow)' }}>
          {error}
        </p>
      )}
      {done && <p className="muted mt-3 text-[12px]">{done}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={busy || pending || blocked}
        className={`${buttonClass('primary')} mt-4`}
      >
        {busy ? 'Saving…' : 'Log time'}
      </button>
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

/** Blank stays blank: an empty box means unknown, never zero. */
function toMinor(value: string): number | null {
  const cleaned = value.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}
