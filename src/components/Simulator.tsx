'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  projectGrowth,
  requiredRevenueForMargin,
  type Baseline,
  type Scenario,
  type ScenarioName,
} from '@/lib/calc/simulator';
import { formatMoney, formatPercent } from '@/lib/money';
import { formatMonthLabel } from '@/lib/dates';
import { Badge, Callout, Card, FormulaNote, SectionHeader, StatTile, buttonClass } from '@/components/ui';
import { formatDateTime } from '@/lib/dates';
import type { SavedScenario } from '@/lib/types';

/**
 * The interactive half of spec §11.
 *
 * Every figure is computed in the browser from the same pure functions the
 * tests cover, so moving a slider costs nothing and no projection is ever
 * persisted. That is deliberate: a saved projection acquires the authority of a
 * record, and next quarter somebody reads last quarter's guess as history.
 */
export function Simulator({
  baseline,
  scenarios,
  scenariosReliable,
  saved,
  canSave,
}: {
  baseline: Baseline;
  scenarios: Scenario[];
  scenariosReliable: boolean;
  /** Plans somebody kept. Never mixed into an actual — see the page docstring. */
  saved: SavedScenario[];
  canSave: boolean;
}) {
  const [mode, setMode] = useState<'growth' | 'margin'>('growth');
  // Start on the custom rate when the presets are not trustworthy. Landing on a
  // preset derived from three erratic months puts a number on screen that looks
  // like a recommendation and is not one.
  const [scenarioName, setScenarioName] = useState<ScenarioName>(
    scenariosReliable ? 'base' : 'custom',
  );
  const [customGrowth, setCustomGrowth] = useState('15');
  const [expenseGrowth, setExpenseGrowth] = useState('5');
  const [months, setMonths] = useState(12);
  const [targetMargin, setTargetMargin] = useState('20');
  /**
   * Spec section 11 asks for a "desired gross OR net profit margin".
   *
   * Net measures against everything the company spends; gross only against
   * what it costs to deliver the work. Same equation, very different answer —
   * so the basis is chosen rather than assumed.
   */
  const [marginBasis, setMarginBasis] = useState<'net' | 'gross'>('net');

  const router = useRouter();
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function saveScenario() {
    if (saveName.trim() === '') {
      setSaveError('Give the plan a name — "Board case, September" beats "scenario 3".');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/scenarios', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: saveName.trim(),
          revenueGrowthRate,
          expenseGrowthRate,
          months,
          targetMarginRatio: mode === 'margin' ? (Number(targetMargin) || 0) / 100 : null,
          marginBasis: mode === 'margin' ? marginBasis : null,
          // The baseline is frozen with the plan. Re-running it against a later
          // baseline would silently change what somebody agreed to.
          baselineRevenueUsdMinor: baseline.revenueUsdMinor,
          baselineExpenseUsdMinor: baseline.expenseUsdMinor,
          baselineMonthsSampled: baseline.monthsSampled,
          baselineAsOf: baseline.lastMonth ?? new Date().toISOString().slice(0, 10),
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!json.ok) {
        setSaveError(json.error ?? 'Could not save that.');
        return;
      }
      setSaveName('');
      router.refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save that.');
    } finally {
      setSaving(false);
    }
  }

  async function removeScenario(id: string) {
    await fetch(`/api/scenarios?id=${id}`, { method: 'DELETE' });
    router.refresh();
  }

  const preset = scenarios.find((s) => s.name === scenarioName);
  const revenueGrowthRate =
    scenarioName === 'custom' ? (Number(customGrowth) || 0) / 100 : (preset?.revenueGrowthRate ?? 0);
  const expenseGrowthRate = (Number(expenseGrowth) || 0) / 100;

  const projection = useMemo(
    () => projectGrowth({ baseline, revenueGrowthRate, expenseGrowthRate, months }),
    [baseline, revenueGrowthRate, expenseGrowthRate, months],
  );

  const marginResult = useMemo(() => {
    const finalExpense =
      projection.months[projection.months.length - 1]?.expenseForecastUsdMinor ??
      baseline.expenseUsdMinor;

    if (marginBasis === 'gross') {
      if (baseline.deliveryCostUsdMinor === null) {
        // Refused rather than measured against zero. A gross target computed
        // against a delivery cost of nothing asks for no revenue at all, and
        // renders as a confident, tiny, wrong number.
        return {
          requiredRevenueUsdMinor: null,
          upliftUsdMinor: null,
          impliedMonthlyGrowth: null,
          impossibleReason:
            'Nothing in this window is categorised as cost of delivery, so there is no gross margin to measure. Categorise the direct costs of the work, or use a net margin.',
        };
      }
      /*
       * Delivery cost is grown at the same rate as everything else.
       *
       * It is an assumption and it is stated: nothing in the ledger says
       * whether delivery scales with revenue or with headcount. Growing it at
       * the expense rate is the same assumption the net projection already
       * makes, so the two modes stay comparable.
       */
      const ratio =
        baseline.expenseUsdMinor > 0 ? finalExpense / baseline.expenseUsdMinor : 1;
      return requiredRevenueForMargin(
        (Number(targetMargin) || 0) / 100,
        Math.round(baseline.deliveryCostUsdMinor * ratio),
        baseline.revenueUsdMinor,
        months,
      );
    }

    return requiredRevenueForMargin(
      (Number(targetMargin) || 0) / 100,
      finalExpense,
      baseline.revenueUsdMinor,
      months,
    );
  }, [projection, baseline, targetMargin, months, marginBasis]);

  const noHistory = baseline.monthsSampled === 0 || baseline.revenueUsdMinor === 0;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Baseline revenue"
          value={formatMoney(baseline.revenueUsdMinor)}
          hint={`Average of ${baseline.monthsSampled} complete month${baseline.monthsSampled === 1 ? '' : 's'}`}
          tone="inflow"
        />
        <StatTile
          label="Baseline spend"
          value={formatMoney(baseline.expenseUsdMinor)}
          hint="Same months, operating outflow"
          tone="outflow"
        />
        <StatTile
          label="How steady that is"
          value={
            baseline.revenueVolatility === null
              ? '—'
              : `±${Math.round(baseline.revenueVolatility * 100)}%`
          }
          hint={volatilityHint(baseline.revenueVolatility)}
          tone={(baseline.revenueVolatility ?? 0) > 0.6 ? 'warn' : 'neutral'}
        />
        <StatTile
          label={`Target, month ${months}`}
          value={
            noHistory
              ? '—'
              : formatMoney(
                  projection.months[projection.months.length - 1]?.revenueTargetUsdMinor ?? 0,
                )
          }
          hint={`${projection.finalMultiple.toFixed(2)}× the baseline`}
          emphasis
        />
      </div>

      {(baseline.revenueVolatility ?? 0) > 0.6 && (
        <div className="mt-5">
          <Callout tone="warn" title="There is no typical month to grow from">
            Monthly revenue varies by about {Math.round((baseline.revenueVolatility ?? 0) * 100)}%
            around its own average, so the baseline describes the arithmetic mean rather than a
            month that has ever happened. Compounding a growth rate off it inherits the noise,
            not the trend. Treat everything below as an order of magnitude.
          </Callout>
        </div>
      )}

      <section className="mt-7">
        <SectionHeader
          title="Set the plan"
          subtitle="Nothing here is saved — this is a calculator, not a record"
        />
        <Card>
          <div className="flex flex-wrap gap-2">
            <Toggle active={mode === 'growth'} onClick={() => setMode('growth')}>
              Grow by a rate
            </Toggle>
            <Toggle active={mode === 'margin'} onClick={() => setMode('margin')}>
              Hit a margin
            </Toggle>
          </div>

          {mode === 'growth' ? (
            <>
              <div className="mt-5 flex flex-wrap gap-2">
                {scenarios.map((s) => (
                  <Toggle
                    key={s.name}
                    active={scenarioName === s.name}
                    onClick={() => setScenarioName(s.name)}
                    title={
                      scenariosReliable
                        ? s.derivation
                        : `${s.derivation} — indicative only, see the note above`
                    }
                  >
                    {s.label} {formatPercent(s.revenueGrowthRate, 0)}
                    {!scenariosReliable && <span className="ml-1 opacity-60">?</span>}
                  </Toggle>
                ))}
                <Toggle active={scenarioName === 'custom'} onClick={() => setScenarioName('custom')}>
                  Custom
                </Toggle>
              </div>

              {preset && scenarioName !== 'custom' && (
                <p className="faint mt-2 text-[11.5px]">{preset.derivation}</p>
              )}

              <div className="mt-5 grid gap-4 sm:grid-cols-3">
                {scenarioName === 'custom' && (
                  <Field label="Revenue growth per month" suffix="%">
                    <input
                      value={customGrowth}
                      onChange={(e) => setCustomGrowth(e.target.value)}
                      className="w-full"
                    />
                  </Field>
                )}
                <Field
                  label="Expense growth per month"
                  suffix="%"
                  hint="Costs do not stay still while revenue triples"
                >
                  <input
                    value={expenseGrowth}
                    onChange={(e) => setExpenseGrowth(e.target.value)}
                    className="w-full"
                  />
                </Field>
                <Field label="Horizon" suffix="months">
                  <select
                    value={months}
                    onChange={(e) => setMonths(Number(e.target.value))}
                    className="w-full"
                  >
                    {[3, 6, 12, 18, 24].map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </>
          ) : (
            <div className="mt-5 grid gap-4 sm:grid-cols-4">
              <Field label="Margin measured against" suffix="">
                {/* Section 11 asks for gross OR net. Net divides into every
                    dollar the company spends; gross only into what delivering
                    the work costs. The same target gives very different
                    revenue depending on which is meant. */}
                <select
                  value={marginBasis}
                  onChange={(e) => setMarginBasis(e.target.value as 'net' | 'gross')}
                  className="w-full"
                >
                  <option value="net">Net — all operating spend</option>
                  <option value="gross">Gross — cost of delivery only</option>
                </select>
              </Field>
              <Field label="Target profit margin" suffix="%">
                <input
                  value={targetMargin}
                  onChange={(e) => setTargetMargin(e.target.value)}
                  className="w-full"
                />
              </Field>
              <Field label="Expense growth per month" suffix="%">
                <input
                  value={expenseGrowth}
                  onChange={(e) => setExpenseGrowth(e.target.value)}
                  className="w-full"
                />
              </Field>
              <Field label="By month" suffix="">
                <select
                  value={months}
                  onChange={(e) => setMonths(Number(e.target.value))}
                  className="w-full"
                >
                  {[3, 6, 12, 18, 24].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
        </Card>
      </section>

      {mode === 'margin' && (
        <section className="mt-7">
          <SectionHeader title={`What a ${targetMargin}% margin needs`} />
          <Card>
            {marginResult.impossibleReason ? (
              <Callout tone="warn">{marginResult.impossibleReason}</Callout>
            ) : (
              <div className="grid gap-4 sm:grid-cols-3">
                <Figure
                  label={`Revenue in month ${months}`}
                  value={formatMoney(marginResult.requiredRevenueUsdMinor ?? 0)}
                />
                <Figure
                  label="More than today"
                  value={formatMoney(marginResult.upliftUsdMinor ?? 0)}
                  warn={(marginResult.upliftUsdMinor ?? 0) > 0}
                />
                <Figure
                  label="Growth that gets there"
                  value={
                    marginResult.impliedMonthlyGrowth === null
                      ? null
                      : `${formatPercent(marginResult.impliedMonthlyGrowth, 1)} / month`
                  }
                />
              </div>
            )}
            <FormulaNote>
              Revenue = forecast expense ÷ (1 − margin), against the spend projected for month{' '}
              {months} rather than today&rsquo;s. Holding costs still would understate the revenue
              a margin actually needs.
            </FormulaNote>
          </Card>
        </section>
      )}

      <section className="mt-7">
        <SectionHeader
          title="Month by month"
          subtitle={
            projection.breakEvenMonth
              ? `Profitable from ${formatMonthLabel(projection.breakEvenMonth)}`
              : 'This plan does not reach profit within the horizon'
          }
        />
        <Card padded={false} className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-[var(--line)] text-left">
                <Th>Month</Th>
                <Th className="text-right">Revenue target</Th>
                <Th className="text-right">Spend forecast</Th>
                <Th className="text-right">Profit</Th>
                <Th className="text-right">Margin</Th>
                <Th className="text-right">Cumulative revenue</Th>
              </tr>
            </thead>
            <tbody>
              {projection.months.map((m) => (
                <tr key={m.monthIndex} className="border-b border-[var(--line)] last:border-0">
                  <Td className="muted tabular">
                    {m.month.includes('-') ? formatMonthLabel(m.month) : m.month}
                    {projection.breakEvenMonth === m.month && (
                      <span className="ml-2">
                        <Badge tone="inflow">break-even</Badge>
                      </span>
                    )}
                  </Td>
                  <Td className="tabular text-right">{formatMoney(m.revenueTargetUsdMinor)}</Td>
                  <Td className="tabular text-right">{formatMoney(m.expenseForecastUsdMinor)}</Td>
                  <Td
                    className="tabular text-right font-medium"
                    style={{
                      color: m.profitUsdMinor < 0 ? 'var(--outflow)' : 'var(--inflow)',
                    }}
                  >
                    {formatMoney(m.profitUsdMinor)}
                  </Td>
                  <Td className="muted tabular text-right">
                    {m.marginRatio === null ? '—' : formatPercent(m.marginRatio, 0)}
                  </Td>
                  <Td className="muted tabular text-right">
                    {formatMoney(m.cumulativeRevenueUsdMinor)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>

      <div className="mt-7">
        <Callout tone="neutral" title="This is a target, not a forecast">
          Nothing here predicts what will happen. It answers one question: if revenue grew{' '}
          {formatPercent(revenueGrowthRate, 0)} a month and spending grew{' '}
          {formatPercent(expenseGrowthRate, 0)}, what would the months look like. Over {months}{' '}
          months that compounds to <strong>{projection.finalMultiple.toFixed(2)}×</strong> the
          revenue AHN makes today — which is the number worth arguing about before the rest of
          the table means anything.
        </Callout>
      </div>

      {/* ── Saved plans (spec §11) ─────────────────────────────────────────
          Labelled a plan everywhere, with the day it was made and the month its
          baseline came from. Nothing here is ever added to an actual. */}
      <section className="mt-7">
        <SectionHeader
          title="Saved plans"
          subtitle="Projections somebody kept, never actuals. Each one remembers the baseline it was built on, so it still means what it meant the day it was agreed."
        />

        {canSave && (
          <Card className="mb-4">
            <div className="flex flex-wrap items-end gap-3">
              <label className="block flex-1" style={{ minWidth: 200 }}>
                <span className="faint block text-[11px] font-semibold uppercase tracking-[0.05em]">
                  Name this plan
                </span>
                <input
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  placeholder="Board case, September"
                  className="mt-1 w-full"
                />
              </label>
              <button
                type="button"
                onClick={saveScenario}
                disabled={saving}
                className={buttonClass('primary')}
              >
                {saving ? 'Saving…' : 'Save the settings above'}
              </button>
            </div>
            <p className="faint mt-2 text-[11px]">
              The inputs are saved, not the figures — every number is recomputed when you open it,
              so a saved plan can never disagree with a fresh one built the same way. The baseline
              is frozen with it.
            </p>
            {saveError && (
              <p className="mt-2 text-[12px]" style={{ color: 'var(--outflow)' }}>
                {saveError}
              </p>
            )}
          </Card>
        )}

        <Card padded={false}>
          {saved.length === 0 ? (
            <p className="muted p-4 text-[13px]">
              No plans saved yet. Set a growth rate or a margin target above, then keep it.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--line)]">
              {saved.map((plan) => (
                <li key={plan.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium">
                      {plan.name} <Badge tone="neutral">plan</Badge>
                    </p>
                    <p className="muted mt-0.5 text-[12px]">
                      {formatPercent(Number(plan.revenue_growth_rate), 0)} revenue growth,{' '}
                      {formatPercent(Number(plan.expense_growth_rate), 0)} expense growth, over{' '}
                      {plan.months} months
                      {plan.target_margin_ratio !== null && (
                        <>
                          {' · '}
                          {formatPercent(Number(plan.target_margin_ratio), 0)} {plan.margin_basis}{' '}
                          margin
                        </>
                      )}
                    </p>
                    <p className="faint mt-0.5 text-[11px]">
                      Saved {formatDateTime(plan.created_at)} · built on the baseline as at{' '}
                      {formatMonthLabel(plan.baseline_as_of)}, when revenue averaged{' '}
                      {formatMoney(plan.baseline_revenue_usd_minor)} a month
                    </p>
                  </div>
                  {canSave && (
                    <button
                      type="button"
                      onClick={() => removeScenario(plan.id)}
                      className="faint text-[11px] underline underline-offset-2"
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </>
  );
}

function volatilityHint(v: number | null): string {
  if (v === null) return 'Needs two complete months';
  if (v < 0.3) return 'Steady — the average describes a real month';
  if (v < 0.6) return 'Moves around, but the average still means something';
  return 'Too lumpy for the average to describe a typical month';
}

function Toggle({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="rounded-full px-3 py-1.5 text-[12.5px] font-medium transition-colors"
      style={{
        background: active ? 'var(--brand-soft)' : 'var(--surface-sunk)',
        color: active ? 'var(--brand)' : 'var(--text-muted)',
      }}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  suffix,
  hint,
  children,
}: {
  label: string;
  suffix?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="faint block text-[11px] font-semibold uppercase tracking-[0.05em]">
        {label} {suffix && <span className="normal-case">({suffix})</span>}
      </span>
      <span className="mt-1 block">{children}</span>
      {hint && <span className="faint mt-1 block text-[11px]">{hint}</span>}
    </label>
  );
}

function Figure({
  label,
  value,
  warn,
}: {
  label: string;
  value: string | null;
  warn?: boolean;
}) {
  return (
    <div>
      <p className="faint text-[11px] font-semibold uppercase tracking-[0.05em]">{label}</p>
      <p
        className="tabular mt-1 text-[18px] font-semibold"
        style={{ color: warn ? 'var(--warn)' : undefined }}
      >
        {value === null ? <span className="faint text-[14px]">not answerable</span> : value}
      </p>
    </div>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`faint px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.05em] ${className}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className = '',
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <td className={`px-4 py-2.5 ${className}`} style={style}>
      {children}
    </td>
  );
}
