'use client';

import { useMemo, useState } from 'react';
import {
  projectGrowth,
  requiredRevenueForMargin,
  type Baseline,
  type Scenario,
  type ScenarioName,
} from '@/lib/calc/simulator';
import { formatMoney, formatPercent } from '@/lib/money';
import { formatMonthLabel } from '@/lib/dates';
import { Badge, Callout, Card, FormulaNote, SectionHeader, StatTile } from '@/components/ui';

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
}: {
  baseline: Baseline;
  scenarios: Scenario[];
  scenariosReliable: boolean;
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
    return requiredRevenueForMargin(
      (Number(targetMargin) || 0) / 100,
      finalExpense,
      baseline.revenueUsdMinor,
      months,
    );
  }, [projection, baseline, targetMargin, months]);

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
            <div className="mt-5 grid gap-4 sm:grid-cols-3">
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
