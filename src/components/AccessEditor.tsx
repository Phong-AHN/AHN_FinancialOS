'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui';
import { ROLE_LABELS, capabilitiesOf } from '@/lib/capabilities';
import type { UserRole } from '@/lib/types';

const ROLES: UserRole[] = [
  'owner',
  'cfo',
  'accountant',
  'department_lead',
  'project_manager',
  'employee',
  'viewer',
];

/**
 * Change one person's role, or link their Slack account - Spec section 23.
 *
 * Nothing here is a permission check. The database refuses a self-promotion,
 * refuses to lose the last owner, and refuses the update entirely from anybody
 * without `manage_people` — see migration 0028. This component's job is to make
 * the consequence visible BEFORE the click, and to show the refusal plainly
 * when it comes.
 */
export function AccessEditor({
  userId,
  email,
  role,
  slackUserId,
  isSelf,
}: {
  userId: string;
  email: string;
  role: UserRole;
  slackUserId: string | null;
  /** The database will refuse this anyway; saying so first is kinder. */
  isSelf: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextRole, setNextRole] = useState<UserRole>(role);
  const [slack, setSlack] = useState(slackUserId ?? '');

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const trimmed = slack.trim();
      const res = await fetch('/api/access', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId,
          ...(nextRole !== role ? { role: nextRole } : {}),
          ...(trimmed !== (slackUserId ?? '')
            ? { slackUserId: trimmed === '' ? null : trimmed }
            : {}),
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium">{email}</p>
          <p className="muted mt-0.5 text-[12px]">
            {ROLE_LABELS[role]}
            {isSelf && <span className="faint"> · you</span>}
            {' · '}
            {slackUserId ? (
              <span>
                Slack <code className="text-[11px]">{slackUserId}</code>
              </span>
            ) : (
              <span className="faint">no Slack account linked</span>
            )}
          </p>
        </div>
        <button type="button" onClick={() => setOpen(true)} className={buttonClass('secondary')}>
          Change
        </button>
      </div>
    );
  }

  const changed = nextRole !== role || slack.trim() !== (slackUserId ?? '');
  const capabilities = capabilitiesOf(nextRole);

  return (
    <div>
      <p className="text-[13px] font-medium">{email}</p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="faint block text-[11px] font-semibold uppercase tracking-[0.05em]">
            Role
          </span>
          <select
            value={nextRole}
            onChange={(e) => setNextRole(e.target.value as UserRole)}
            disabled={isSelf}
            className="mt-1"
            style={{ minWidth: 200 }}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="faint block text-[11px] font-semibold uppercase tracking-[0.05em]">
            Slack member id
          </span>
          <input
            value={slack}
            onChange={(e) => setSlack(e.target.value)}
            placeholder="U01ABC2DEF"
            style={{ width: 180 }}
            className="mt-1"
          />
        </label>

        <button
          type="button"
          onClick={save}
          disabled={busy || pending || !changed}
          className={buttonClass('primary')}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setNextRole(role);
            setSlack(slackUserId ?? '');
            setError(null);
          }}
          disabled={busy}
          className={buttonClass('secondary')}
        >
          Cancel
        </button>
      </div>

      {isSelf && (
        <p className="faint mt-2 text-[11px]">
          You cannot change your own role — ask another owner. Any role that could promote itself
          would make the whole model advisory.
        </p>
      )}

      {/* What the choice actually means, in front of the person making it. A
          role name is not self-explanatory, and "department lead" sounds more
          powerful than "viewer" while seeing considerably less. */}
      <p className="faint mt-2 text-[11px]">
        {ROLE_LABELS[nextRole]} can:{' '}
        {capabilities.length === 0 ? (
          <>nothing beyond their own record and hours.</>
        ) : (
          <>{capabilities.map((c) => c.replace(/_/g, ' ')).join(', ')}.</>
        )}
      </p>

      <p className="faint mt-1 text-[11px]">
        The Slack id is in Slack under the person&rsquo;s profile → Copy member ID. Without it their
        slash commands are refused, whatever their role here.
      </p>

      {error && (
        <p className="mt-2 text-[12px]" style={{ color: 'var(--outflow)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
