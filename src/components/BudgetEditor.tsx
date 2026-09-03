'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui';
import { categoryLabel } from '@/lib/categorize';

interface Targets {
  companies: Array<{ id: string; name: string }>;
  businessUnits: Array<{ id: string; name: string }>;
  clients: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; name: string }>;
  categories: string[];
}

type Scope = 'total' | 'category' | 'business_unit' | 'client' | 'project' | 'company';
type Period = 'month' | 'quarter' | 'year';

const SCOPE_LABELS: Record<Scope, string> = {
  total: 'Everything the company spends',
  category: 'A spending category',
  business_unit: 'A business unit',
  client: 'A client',
  project: 'A project or event',
  company: 'A legal entity',
};

/**
 * Set a budget - Spec section 19.
 *
 * The period start is forced to the first of a month, and to a quarter or year
 * boundary where that applies. A budget whose window does not line up with the
 * calendar cannot be compared against spending that is reported by calendar
 * month, and "how far through are we" — which the whole projection rests on —
 * would be measured against the wrong thing.
 */
export function BudgetEditor({ targets }: { targets: Targets }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [scope, setScope] = useState<Scope>('category');
  const [scopeId, setScopeId] = useState('');
  const [scopeKey, setScopeKey] = useState('');
  const [period, setPeriod] = useState<Period>('month');
  const [startsOn, setStartsOn] = useState(() => defaultStart('month'));
  const [amount, setAmount] = useState('');

  function changePeriod(next: Period) {
    setPeriod(next);
    setStartsOn(defaultStart(next));
  }

  const options =
    scope === 'business_unit'
      ? targets.businessUnits
      : scope === 'client'
        ? targets.clients
        : scope === 'project'
          ? targets.projects
          : scope === 'company'
            ? targets.companies
            : [];

  async function submit() {
    const minor = toMinor(amount);
    if (!name.trim()) return setError('A budget needs a name.');
    if (minor === null) return setError('Enter the amount this budget allows.');
    if (scope === 'category' && !scopeKey) return setError('Pick a category.');
    if (options.length > 0 && !scopeId) return setError(`Pick a ${SCOPE_LABELS[scope].toLowerCase()}.`);

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/budgets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          scope,
          scopeId: scope === 'category' || scope === 'total' ? null : scopeId,
          scopeKey: scope === 'category' ? scopeKey : null,
          period,
          startsOn,
          amountMinor: minor,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!json.ok) return setError(json.error ?? 'Could not save the budget.');
      setOpen(false);
      setName('');
      setAmount('');
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the budget.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('primary')}>
        New budget
      </button>
    );
  }

  return (
    <div className="card w-full max-w-[620px] p-5">
      <p className="mb-3 text-[13px] font-semibold">New budget</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Marketing, Q3"
            className="w-full"
          />
        </Field>

        <Field label="Applies to">
          <select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as Scope);
              setScopeId('');
              setScopeKey('');
            }}
            className="w-full"
          >
            {(Object.keys(SCOPE_LABELS) as Scope[]).map((s) => (
              <option key={s} value={s}>
                {SCOPE_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>

        {scope === 'category' && (
          <Field label="Category">
            <select
              value={scopeKey}
              onChange={(e) => setScopeKey(e.target.value)}
              className="w-full"
            >
              <option value="">—</option>
              {targets.categories.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </select>
          </Field>
        )}

        {options.length > 0 && (
          <Field label="Which one">
            <select value={scopeId} onChange={(e) => setScopeId(e.target.value)} className="w-full">
              <option value="">—</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        {options.length === 0 && scope !== 'category' && scope !== 'total' && (
          <Field label="Which one">
            <p className="muted text-[12px]">
              Nothing to pick yet — create a {scope.replace('_', ' ')} first.
            </p>
          </Field>
        )}

        <Field label="Period">
          <select
            value={period}
            onChange={(e) => changePeriod(e.target.value as Period)}
            className="w-full"
          >
            <option value="month">Monthly</option>
            <option value="quarter">Quarterly</option>
            <option value="year">Yearly</option>
          </select>
        </Field>

        <Field
          label="Starting"
          hint="Aligned to the calendar, so spending can be compared against it"
        >
          <input
            type="date"
            value={startsOn}
            onChange={(e) => setStartsOn(e.target.value)}
            className="w-full"
          />
        </Field>

        <Field label="Amount (USD)">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="40000"
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
          {busy ? 'Saving…' : 'Save budget'}
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

/** The first day of the current period, so the default is always valid. */
function defaultStart(period: Period): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const first =
    period === 'year' ? 0 : period === 'quarter' ? Math.floor(month / 3) * 3 : month;
  return `${year}-${String(first + 1).padStart(2, '0')}-01`;
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
