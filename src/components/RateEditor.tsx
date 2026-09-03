'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass } from '@/components/ui';

/**
 * Set the USD rate for a currency - Spec section 3.
 *
 * Entered as "how many dong to one dollar", because that is how everyone in
 * Vietnam quotes it and how every rate you look up is published. The stored
 * figure is its reciprocal — USD per unit — and doing that conversion here is
 * the whole point: typing 26000 into a field expecting 0.000038 would value one
 * dong at twenty-six thousand dollars, and the resulting cash total would look
 * astronomical rather than obviously wrong.
 */
/** Where a stored rate came from, in words a reader can weigh. */
export function describeRateSource(source: string): string {
  if (source.startsWith('manual:')) return `set by ${source.slice('manual:'.length)}`;
  if (source.startsWith('vietcombank')) return 'Vietcombank';
  if (source === 'exchangerate-api') return 'mid-market feed';
  if (source === 'seed') return 'starting estimate, never updated';
  return source;
}

/** A rate is treated as stale after a week; a bank republishes every weekday. */
export const STALE_AFTER_DAYS = 7;

export interface RateProvenance {
  asOf: string;
  source: string;
  ageDays: number;
}

export function RateEditor({
  currency,
  currentRate,
  asOf,
  canEdit,
  provenance,
}: {
  currency: string;
  currentRate: number | null;
  /** The reporting date the page is showing — not the date of the rate. */
  asOf: string;
  canEdit: boolean;
  /**
   * The stored row this rate actually came from.
   *
   * Without it this component printed "as of {asOf}", where asOf was today.
   * A rate set three weeks ago and never touched since claimed to be today's,
   * which is the one thing a reader must not be told: a stale rate converts
   * every balance in the currency silently, and this line was the only place
   * that could have admitted it.
   */
  provenance?: RateProvenance | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Shown per dollar: 1 / 0.000038 = 26,316.
  const perDollar = currentRate && currentRate > 0 ? Math.round(1 / currentRate) : null;
  const [value, setValue] = useState(perDollar ? String(perDollar) : '');

  async function save() {
    const units = Number(value.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(units) || units <= 0) {
      setError(`Enter how many ${currency} make one US dollar.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/exchange-rates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseCurrency: currency, rate: 1 / units }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!json.ok) {
        setError(json.error ?? 'Could not save the rate.');
        return;
      }
      setOpen(false);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the rate.');
    } finally {
      setBusy(false);
    }
  }

  const stale = provenance !== null && provenance !== undefined && provenance.ageDays > STALE_AFTER_DAYS;
  const detail = provenance
    ? `${provenance.asOf} · ${describeRateSource(provenance.source)}` +
      (provenance.ageDays > 0 ? ` · ${provenance.ageDays} days old` : '')
    : `no rate on file as of ${asOf}`;

  const Detail = () => (
    <span className={stale ? 'text-[12px]' : 'faint text-[12px]'} style={stale ? { color: 'var(--warn, var(--outflow))' } : undefined}>
      {' '}
      · {detail}
    </span>
  );

  if (!canEdit) {
    return (
      <p className="muted text-[12.5px]">
        1 USD = {perDollar ? perDollar.toLocaleString('en-US') : '—'} {currency}
        <Detail />
      </p>
    );
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-[12.5px]">
          1 USD = <strong>{perDollar ? perDollar.toLocaleString('en-US') : 'not set'}</strong>{' '}
          {currency}
          <Detail />
        </p>
        <button type="button" onClick={() => setOpen(true)} className={buttonClass('secondary')}>
          {perDollar ? 'Update' : 'Set rate'}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="block">
        <span className="faint block text-[11px] font-semibold uppercase tracking-[0.05em]">
          {currency} to one US dollar
        </span>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="26000"
          style={{ width: 140 }}
          className="mt-1"
        />
      </label>
      <button
        type="button"
        onClick={save}
        disabled={busy || pending}
        className={buttonClass('primary')}
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        disabled={busy}
        className={buttonClass('secondary')}
      >
        Cancel
      </button>
      {error && (
        <span className="text-[12px]" style={{ color: 'var(--outflow)' }}>
          {error}
        </span>
      )}
      <p className="faint w-full text-[11px]">
        Stored dated, never overwritten in place — a report re-run for last month keeps last
        month&rsquo;s rate. A rate you set by hand stands: the daily feed writes only where nobody
        has.
      </p>
    </div>
  );
}
