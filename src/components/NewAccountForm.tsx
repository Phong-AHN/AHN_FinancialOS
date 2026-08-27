'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui';
import type { Company } from '@/lib/types';

/**
 * Create the manual accounts that CSV statements import into - the VN bank
 * account, the VEEM balance, the payroll clearing account.
 *
 * The opening balance matters: an imported statement usually starts partway
 * through an account life, and without a starting figure the derived balance
 * is short by everything that happened before the file begins.
 */
export function NewAccountForm({ companies }: { companies: Company[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? '');
  const [type, setType] = useState('checking');
  const [currency, setCurrency] = useState('VND');
  const [openingBalance, setOpeningBalance] = useState('');
  const [includeInCash, setIncludeInCash] = useState(true);

  async function submit() {
    setSaving(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          companyId: companyId || null,
          type,
          currency,
          openingBalance: openingBalance.trim() || '0',
          includeInCash,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; name?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? 'Could not create the account.');
      } else {
        setDone(`Created "${json.name}".`);
        setName('');
        setOpeningBalance('');
        startTransition(() => router.refresh());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the account.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <label className="block md:col-span-2">
          <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">Account name</span>
          <input
            type="text"
            value={name}
            placeholder="e.g. Techcombank — AHN Vietnam operating"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="block">
          <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">Entity</span>
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            {companies.length === 0 && <option value="">Default entity</option>}
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="checking">Checking</option>
            <option value="savings">Savings</option>
            <option value="credit_card">Credit card</option>
            <option value="payment_processor">Payment processor</option>
            <option value="cash">Cash</option>
            <option value="other">Other</option>
          </select>
        </label>

        <label className="block">
          <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">Currency</span>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="USD">USD</option>
            <option value="VND">VND</option>
            <option value="PHP">PHP</option>
            <option value="EUR">EUR</option>
            <option value="SGD">SGD</option>
          </select>
        </label>

        <label className="block">
          <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">
            Opening balance
          </span>
          <input
            type="text"
            value={openingBalance}
            placeholder="0"
            onChange={(e) => setOpeningBalance(e.target.value)}
          />
          <span className="faint mt-1 block text-[11.5px]">
            The balance before the first row of the statement you are importing.
          </span>
        </label>
      </div>

      <label className="flex items-center gap-2 text-[12.5px]">
        <input
          type="checkbox"
          checked={includeInCash}
          onChange={(e) => setIncludeInCash(e.target.checked)}
          className="accent-[var(--brand)]"
          style={{ width: 16, height: 16 }}
        />
        Count this account toward total cash
        <span className="faint">(leave off for credit cards — a card balance is a liability)</span>
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          className={buttonClass('primary')}
          disabled={!name.trim() || saving || pending}
          onClick={submit}
        >
          {saving ? 'Creating…' : 'Create account'}
        </button>
        {error && <span className="text-[12.5px]" style={{ color: 'var(--outflow)' }}>{error}</span>}
        {done && <span className="text-[12.5px]" style={{ color: 'var(--inflow)' }}>{done}</span>}
      </div>
    </div>
  );
}
