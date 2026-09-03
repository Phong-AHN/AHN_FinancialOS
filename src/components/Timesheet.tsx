'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui';

export interface TimesheetProject {
  id: string;
  name: string;
  kind: string;
}

/**
 * Log your own hours - Spec section 13.
 *
 * No permission logic here. Migration 0029 lets somebody write rows for their
 * own person, dated within the last fortnight, and refuses everything else —
 * so this form's job is to make the allowed range obvious before the click and
 * to show the refusal plainly if it comes anyway.
 */
export function Timesheet({
  personId,
  projects,
  today,
  earliest,
}: {
  personId: string;
  projects: TimesheetProject[];
  today: string;
  /** The oldest date self-service still accepts, so the picker cannot offer worse. */
  earliest: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [workDate, setWorkDate] = useState(today);
  const [hours, setHours] = useState('');
  const [notes, setNotes] = useState('');

  async function save() {
    const value = Number(hours);
    if (!Number.isFinite(value) || value <= 0 || value > 24) {
      setError('Hours must be between 0 and 24.');
      return;
    }
    if (!projectId) {
      setError('Pick a project.');
      return;
    }

    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch('/api/time-entries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          personId,
          projectId,
          workDate,
          hours: value,
          notes: notes.trim() === '' ? null : notes.trim(),
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!json.ok) {
        setError(json.error ?? 'Could not save that.');
        return;
      }
      setHours('');
      setNotes('');
      setSaved(`${value} hour${value === 1 ? '' : 's'} recorded for ${workDate}.`);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  }

  if (projects.length === 0) {
    return (
      <p className="muted text-[13px]">
        There are no open projects to log against yet.
      </p>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="faint block text-[11px] font-semibold uppercase tracking-[0.05em]">
            Project
          </span>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="mt-1"
            style={{ minWidth: 220 }}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.kind === 'event' ? ' (event)' : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="faint block text-[11px] font-semibold uppercase tracking-[0.05em]">
            Day
          </span>
          {/* Bounded to the window the database will accept, so the form cannot
              offer a date that is going to be refused. */}
          <input
            type="date"
            value={workDate}
            min={earliest}
            max={today}
            onChange={(e) => setWorkDate(e.target.value)}
            className="mt-1"
          />
        </label>

        <label className="block">
          <span className="faint block text-[11px] font-semibold uppercase tracking-[0.05em]">
            Hours
          </span>
          <input
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            placeholder="7.5"
            inputMode="decimal"
            style={{ width: 90 }}
            className="mt-1"
          />
        </label>

        <label className="block flex-1" style={{ minWidth: 180 }}>
          <span className="faint block text-[11px] font-semibold uppercase tracking-[0.05em]">
            What you did (optional)
          </span>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Editing the launch film"
            className="mt-1 w-full"
          />
        </label>

        <button
          type="button"
          onClick={save}
          disabled={busy || pending}
          className={buttonClass('primary')}
        >
          {busy ? 'Saving…' : 'Log hours'}
        </button>
      </div>

      <p className="faint mt-2 text-[11px]">
        One entry per project per day — logging the same day again replaces it rather than adding
        to it, so a double-click cannot double your hours.
      </p>

      {error && (
        <p className="mt-2 text-[12px]" style={{ color: 'var(--outflow)' }}>
          {error}
        </p>
      )}
      {saved && (
        <p className="mt-2 text-[12px]" style={{ color: 'var(--inflow)' }}>
          {saved}
        </p>
      )}
    </div>
  );
}
