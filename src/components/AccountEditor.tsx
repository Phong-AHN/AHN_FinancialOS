'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui';
import { toMajor } from '@/lib/money';

/**
 * Correcting one account, from the row it appears on.
 *
 * The two fields that move the company's headline cash figure — "counted as
 * cash" and "still in use" — say what they do to that figure, right where they
 * are changed. A switch labelled `include_in_cash` tells a reader what column
 * it maps to; it does not tell them they are about to move the number the CEO
 * reads each morning.
 *
 * Closed by default: the accounts page is read first and edited rarely.
 */
export interface EditableAccount {
  id: string;
  name: string;
  type: string;
  currency: string;
  sourceSystem: string;
  includeInCash: boolean;
  isActive: boolean;
  openingBalanceMinor: number;
  reportedBalanceMinor: number | null;
}

const TYPES = [
  ['checking', 'Checking'],
  ['savings', 'Savings'],
  ['credit_card', 'Credit card'],
  ['payment_processor', 'Payment processor'],
  ['cash', 'Cash'],
  ['other', 'Other'],
] as const;

export function AccountEditor({ account }: { account: EditableAccount }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const [name, setName] = useState(account.name);
  const [type, setType] = useState(account.type);
  const [includeInCash, setIncludeInCash] = useState(account.includeInCash);
  const [isActive, setIsActive] = useState(account.isActive);
  const [openingBalance, setOpeningBalance] = useState(
    String(toMajor(account.openingBalanceMinor, account.currency)),
  );
  const [reportedBalance, setReportedBalance] = useState(
    account.reportedBalanceMinor === null ? '' : String(toMajor(account.reportedBalanceMinor, account.currency)),
  );
  const [reason, setReason] = useState('');

  const providerOwned = account.sourceSystem !== 'manual';

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const body: Record<string, unknown> = {
        name,
        type,
        includeInCash,
        isActive,
        openingBalance,
        reason: reason || undefined,
      };
      if (!providerOwned) body.reportedBalance = reportedBalance === '' ? null : reportedBalance;

      const res = await fetch(`/api/accounts/${account.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { ok: boolean; changed?: number; error?: string; message?: string };
      if (!json.ok) throw new Error(json.error ?? 'Could not save.');

      setNote({
        ok: true,
        text: json.changed
          ? `Saved. ${json.changed} field${json.changed === 1 ? '' : 's'} changed and written to the audit log.`
          : (json.message ?? 'Nothing was different.'),
      });
      setReason('');
      router.refresh();
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : 'Could not save.' });
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="faint mt-1 text-[11.5px] underline underline-offset-2" onClick={() => setOpen(true)}>
        Correct this account
      </button>
    );
  }

  return (
    <form onSubmit={save} className="mt-2 grid gap-2 border-l-2 border-[var(--line)] pl-3 text-[12.5px]">
      <label className="block">
        <span className="faint block text-[11px] font-medium uppercase tracking-wide">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
      </label>

      <label className="block">
        <span className="faint block text-[11px] font-medium uppercase tracking-wide">Type</span>
        <select value={type} onChange={(e) => setType(e.target.value)} disabled={busy}>
          {TYPES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={includeInCash}
          onChange={(e) => setIncludeInCash(e.target.checked)}
          disabled={busy}
          className="mt-0.5"
        />
        <span>
          Counted as cash
          <span className="faint block text-[11.5px]">
            Its balance is added to the company&rsquo;s cash figure, and to runway. Turn this off for a
            credit card, a loan, or an account the business no longer uses.
          </span>
        </span>
      </label>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
          disabled={busy}
          className="mt-0.5"
        />
        <span>
          Still in use
          <span className="faint block text-[11.5px]">
            Unticking removes it from every total and from the accounts list. Its transactions stay in
            the ledger and in exports — nothing is deleted.
          </span>
        </span>
      </label>

      <label className="block">
        <span className="faint block text-[11px] font-medium uppercase tracking-wide">
          Opening balance ({account.currency})
        </span>
        <input value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} disabled={busy} />
        <span className="faint block text-[11.5px]">
          What the account held before the first imported transaction. Only used when no provider
          reports a balance.
        </span>
      </label>

      {!providerOwned && (
        <label className="block">
          <span className="faint block text-[11px] font-medium uppercase tracking-wide">
            Statement balance ({account.currency})
          </span>
          <input
            value={reportedBalance}
            onChange={(e) => setReportedBalance(e.target.value)}
            placeholder="leave empty to compute from transactions"
            disabled={busy}
          />
          <span className="faint block text-[11.5px]">
            The closing balance on the bank statement. Set it and the dashboard shows this instead of
            the running total, with the difference reported as variance.
          </span>
        </label>
      )}

      {providerOwned && (
        <p className="faint text-[11.5px]">
          The balance comes from {account.sourceSystem.replace(/_/g, ' ')} and is refreshed on every
          sync, so it cannot be set here. Correct it at the provider, then sync.
        </p>
      )}

      <label className="block">
        <span className="faint block text-[11px] font-medium uppercase tracking-wide">Why (for the audit log)</span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. closed in June, replaced by TOTAL BUS CHK"
          disabled={busy}
        />
      </label>

      <div className="flex gap-2">
        <button type="submit" className={buttonClass('primary')} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className={buttonClass()} onClick={() => setOpen(false)} disabled={busy}>
          Close
        </button>
      </div>

      {note && (
        <p className={note.ok ? 'muted' : ''} role="status">
          {note.text}
        </p>
      )}
    </form>
  );
}
