'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  CSV_PRESETS,
  mapRowsToTransactions,
  parseCsv,
  suggestColumnMap,
  type ColumnMap,
} from '@/lib/connectors/csv';
import { formatMoney } from '@/lib/money';
import { buttonClass, Badge, Callout, Money } from '@/components/ui';
import type { FinancialAccount } from '@/lib/types';

/**
 * CSV import with column mapping - MVP Plan Day 1, used for real on Day 6.
 *
 * The file is parsed in the browser purely to build the preview; the server
 * re-parses the same text before writing anything, so a hand-crafted request
 * cannot smuggle in rows that were never in the file.
 *
 * The preview is the safety feature. VN bank statements are DD/MM/YYYY with
 * comma decimals and separate Ghi Nợ / Ghi Có columns - every one of those is a
 * chance to silently import a 25,000x wrong number. Showing the parsed result
 * before the write makes a bad mapping obvious in a glance.
 */
export function CsvImporter({
  accounts,
  canImport,
}: {
  accounts: FinancialAccount[];
  canImport: boolean;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();

  const [presetKey, setPresetKey] = useState<string>('vn_bank');
  const [accountId, setAccountId] = useState<string>(accounts[0]?.id ?? '');
  const [fileName, setFileName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string>('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Array<Record<string, string>>>([]);
  const [map, setMap] = useState<Partial<ColumnMap>>({});
  const [dayFirst, setDayFirst] = useState(true);
  const [decimalSeparator, setDecimalSeparator] = useState<'.' | ','>(',');
  const [forceOutflow, setForceOutflow] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const preset = CSV_PRESETS[presetKey]!;
  const account = accounts.find((a) => a.id === accountId);

  function applyPreset(key: string) {
    setPresetKey(key);
    const p = CSV_PRESETS[key]!;
    setDayFirst(p.dayFirst);
    setDecimalSeparator(p.decimalSeparator);
    setForceOutflow(key === 'payroll' || key === 'veem');
  }

  async function onFile(file: File) {
    const text = await file.text();
    const parsed = parseCsv(text);
    setFileName(file.name);
    setCsvText(text);
    setHeaders(parsed.headers);
    setRows(parsed.rows);
    setMap(suggestColumnMap(parsed.headers));
    setResult(null);
  }

  // Re-run the real mapper on the first rows so the preview is produced by the
  // same code that will do the import, not a lookalike.
  const preview = useMemo(() => {
    if (!map.date || rows.length === 0 || !accountId) return null;
    return mapRowsToTransactions(rows.slice(0, 200), map as ColumnMap, {
      accountId,
      sourceSystem: preset.sourceSystem,
      defaultCurrency: account?.currency ?? preset.defaultCurrency,
      dayFirst,
      decimalSeparator,
      forceDirection: forceOutflow ? 'outflow' : undefined,
      fileName: fileName ?? 'preview.csv',
    });
  }, [map, rows, accountId, preset, account, dayFirst, decimalSeparator, forceOutflow, fileName]);

  const totalIn = preview?.transactions.filter((t) => t.direction === 'inflow').reduce((s, t) => s + t.amount_minor, 0) ?? 0;
  const totalOut = preview?.transactions.filter((t) => t.direction === 'outflow').reduce((s, t) => s + t.amount_minor, 0) ?? 0;
  const currency = account?.currency ?? preset.defaultCurrency;

  const canSubmit =
    canImport && !!accountId && !!map.date && (!!map.amount || !!map.debit || !!map.credit) && rows.length > 0;

  async function submit() {
    setUploading(true);
    setResult(null);
    try {
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          csv: csvText,
          fileName: fileName ?? 'import.csv',
          accountId,
          preset: presetKey,
          columnMap: map,
          dayFirst,
          decimalSeparator,
          forceOutflow,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        inserted?: number;
        skipped?: number;
        rowErrors?: number;
        error?: string;
      };

      if (!res.ok || !json.ok) {
        setResult({ ok: false, message: json.error ?? 'Import failed.' });
      } else {
        setResult({
          ok: true,
          message: `Imported ${json.inserted} transaction${json.inserted === 1 ? '' : 's'}. ${json.skipped ?? 0} already existed, ${json.rowErrors ?? 0} row${json.rowErrors === 1 ? '' : 's'} could not be read.`,
        });
        startTransition(() => router.refresh());
      }
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : 'Import failed.' });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* ── Step 1 ────────────────────────────────────────────────────────── */}
      <div className="card p-5">
        <Step n={1} title="What kind of file is this?" />
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">Source</span>
            <select value={presetKey} onChange={(e) => applyPreset(e.target.value)}>
              {Object.entries(CSV_PRESETS).map(([key, p]) => (
                <option key={key} value={key}>
                  {p.label}
                </option>
              ))}
            </select>
            <span className="faint mt-1 block text-[11.5px]">{preset.hint}</span>
          </label>

          <label className="block">
            <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">
              Import into which account
            </span>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.length === 0 && <option value="">No accounts yet</option>}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.currency})
                </option>
              ))}
            </select>
            <span className="faint mt-1 block text-[11.5px]">
              Amounts with no currency column are read as {currency}.
            </span>
          </label>
        </div>
      </div>

      {/* ── Step 2 ────────────────────────────────────────────────────────── */}
      <div className="card p-5">
        <Step n={2} title="Choose the file" />
        <div className="mt-3 flex items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onFile(file);
            }}
          />
          <button type="button" className={buttonClass('secondary')} onClick={() => fileRef.current?.click()}>
            {fileName ? 'Choose a different file' : 'Choose CSV file'}
          </button>
          {fileName && (
            <span className="text-[13px]">
              <span className="font-medium">{fileName}</span>{' '}
              <span className="faint">
                — {rows.length} row{rows.length === 1 ? '' : 's'}, {headers.length} columns
              </span>
            </span>
          )}
        </div>
      </div>

      {/* ── Step 3 ────────────────────────────────────────────────────────── */}
      {headers.length > 0 && (
        <div className="card p-5">
          <Step n={3} title="Map the columns" />
          <p className="faint mt-1 text-[12px]">
            Pre-filled by matching the header names, including Vietnamese ones. Correct anything
            that looks wrong — the preview below updates as you go.
          </p>

          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <MapField label="Date *" value={map.date} headers={headers} onChange={(v) => setMap({ ...map, date: v })} />
            <MapField label="Description" value={map.description} headers={headers} onChange={(v) => setMap({ ...map, description: v })} />
            <MapField label="Counterparty" value={map.counterparty} headers={headers} onChange={(v) => setMap({ ...map, counterparty: v })} />
            <MapField label="Amount (signed)" value={map.amount} headers={headers} onChange={(v) => setMap({ ...map, amount: v })} />
            <MapField label="Debit / money out" value={map.debit} headers={headers} onChange={(v) => setMap({ ...map, debit: v })} />
            <MapField label="Credit / money in" value={map.credit} headers={headers} onChange={(v) => setMap({ ...map, credit: v })} />
            <MapField label="Currency" value={map.currency} headers={headers} onChange={(v) => setMap({ ...map, currency: v })} />
            <MapField label="Reference / txn ID" value={map.reference} headers={headers} onChange={(v) => setMap({ ...map, reference: v })} />
            <MapField label="Category" value={map.category} headers={headers} onChange={(v) => setMap({ ...map, category: v })} />
          </div>

          <div className="mt-4 flex flex-wrap gap-6 border-t border-[var(--line)] pt-4 text-[12.5px]">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={dayFirst} onChange={(e) => setDayFirst(e.target.checked)} style={{ width: 16, height: 16 }} className="accent-[var(--brand)]" />
              Dates are day-first (31/12/2026)
            </label>
            <label className="flex items-center gap-2">
              <span>Decimal separator</span>
              <select
                value={decimalSeparator}
                onChange={(e) => setDecimalSeparator(e.target.value as '.' | ',')}
                style={{ width: 'auto' }}
              >
                <option value=".">. (1,234.56)</option>
                <option value=",">, (1.234,56)</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={forceOutflow} onChange={(e) => setForceOutflow(e.target.checked)} style={{ width: 16, height: 16 }} className="accent-[var(--brand)]" />
              Every row is money out (payroll / VEEM runs)
            </label>
          </div>

          {!map.amount && !map.debit && !map.credit && (
            <div className="mt-4">
              <Callout tone="warn">
                Map either a signed amount column, or a debit/credit pair. Without one there is no
                way to tell how much moved.
              </Callout>
            </div>
          )}
        </div>
      )}

      {/* ── Step 4 ────────────────────────────────────────────────────────── */}
      {preview && (
        <div className="card p-5">
          <Step n={4} title="Check the preview before importing" />

          <div className="mt-3 flex flex-wrap items-center gap-5 text-[13px]">
            <span>
              <span className="faint">Readable rows: </span>
              <span className="tabular font-semibold">{preview.transactions.length}</span>
              {rows.length > 200 && <span className="faint"> of the first 200</span>}
            </span>
            <span>
              <span className="faint">Money in: </span>
              <Money minor={totalIn} currency={currency} direction="inflow" className="font-semibold" />
            </span>
            <span>
              <span className="faint">Money out: </span>
              <Money minor={totalOut} currency={currency} direction="outflow" className="font-semibold" />
            </span>
            {preview.errors.length > 0 && (
              <Badge tone="warn">{preview.errors.length} unreadable row{preview.errors.length === 1 ? '' : 's'}</Badge>
            )}
          </div>

          <div className="mt-4 overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Counterparty / description</th>
                  <th>Direction</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {preview.transactions.slice(0, 8).map((t) => (
                  <tr key={t.external_txn_id}>
                    <td className="tabular whitespace-nowrap">{t.txn_date}</td>
                    <td>{t.counterparty_name ?? t.description ?? '—'}</td>
                    <td>
                      <Badge tone={t.direction === 'inflow' ? 'inflow' : 'outflow'}>
                        {t.direction === 'inflow' ? 'Money in' : 'Money out'}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap text-right">
                      <Money minor={t.amount_minor} currency={t.currency} direction={t.direction} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {preview.errors.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-[12.5px] font-medium">
                {preview.errors.length} row{preview.errors.length === 1 ? '' : 's'} could not be read
                — they will be skipped, not imported as zero
              </summary>
              <ul className="faint mt-2 space-y-1 text-[11.5px]">
                {preview.errors.slice(0, 10).map((e) => (
                  <li key={e.rowNumber}>
                    Row {e.rowNumber}: {e.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {preview.transactions.length > 0 && (
            <p className="faint mt-4 text-[11.5px] leading-relaxed">
              Sanity check: does the largest amount look right? A VN statement read with the wrong
              decimal separator turns {formatMoney(1234567, 'VND')} into{' '}
              {formatMoney(123456700, 'VND')}. Re-importing the same file is safe — rows carry a
              stable key and will not double-count.
            </p>
          )}

          <div className="mt-5 flex items-center gap-3 border-t border-[var(--line)] pt-4">
            <button
              type="button"
              className={buttonClass('primary')}
              disabled={!canSubmit || uploading || pending}
              onClick={submit}
            >
              {uploading ? 'Importing…' : `Import ${rows.length} row${rows.length === 1 ? '' : 's'}`}
            </button>
            {!canImport && <span className="faint text-[12px]">Importing is restricted to the owner role.</span>}
            {result && (
              <span className="text-[12.5px]" style={{ color: result.ok ? 'var(--inflow)' : 'var(--outflow)' }}>
                {result.message}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Step({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className="tabular flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold"
        style={{ background: 'var(--brand-soft)', color: 'var(--brand)' }}
      >
        {n}
      </span>
      <h3 className="text-[14px] font-semibold">{title}</h3>
    </div>
  );
}

function MapField({
  label,
  value,
  headers,
  onChange,
}: {
  label: string;
  value: string | undefined;
  headers: string[];
  onChange: (value: string | undefined) => void;
}) {
  return (
    <label className="block">
      <span className="faint mb-1 block text-[11px] font-medium uppercase tracking-wide">{label}</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">— not in this file —</option>
        {headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
    </label>
  );
}
