import { formatDayLabel } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import type { CashPoint } from '@/lib/calc/engine';

/**
 * 30-day cash line. Inline SVG rather than a charting library: it is one
 * series, it has to render on the server with no hydration cost, and it must
 * read correctly in both themes.
 *
 * The y-axis deliberately does NOT start at zero. For a cash balance that
 * hovers around a large number, a zero-based axis flattens the line into a
 * meaningless straight edge and hides exactly the week-to-week movement the
 * CEO is looking for. The axis labels state the real range so the scale is
 * never misread.
 */
export function CashTrend({ points }: { points: CashPoint[] }) {
  if (points.length < 2) {
    return (
      <div className="faint flex h-[120px] items-center justify-center text-[12px]">
        Not enough history yet for a trend.
      </div>
    );
  }

  const width = 720;
  const height = 130;
  const padTop = 12;
  const padBottom = 20;

  const values = points.map((p) => p.cashUsdMinor);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(1, Math.abs(max) * 0.1);
  // Breathing room so the line never touches the frame.
  const lo = min - span * 0.12;
  const hi = max + span * 0.12;

  const x = (i: number) => (i / (points.length - 1)) * width;
  const y = (v: number) => padTop + (1 - (v - lo) / (hi - lo)) * (height - padTop - padBottom);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.cashUsdMinor).toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height - padBottom} L0,${height - padBottom} Z`;

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const rising = last.cashUsdMinor >= first.cashUsdMinor;
  const stroke = rising ? 'var(--inflow)' : 'var(--outflow)';

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Cash over the last ${points.length} days, from ${formatMoney(first.cashUsdMinor)} to ${formatMoney(last.cashUsdMinor)}`}
      >
        <defs>
          <linearGradient id="cashFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.18" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line
          x1="0"
          y1={height - padBottom}
          x2={width}
          y2={height - padBottom}
          stroke="var(--line)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        <path d={area} fill="url(#cashFill)" />
        <path
          d={line}
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        <circle cx={x(points.length - 1)} cy={y(last.cashUsdMinor)} r="3.5" fill={stroke} />
      </svg>

      <div className="mt-1 flex items-center justify-between">
        <span className="faint text-[11px]">
          {formatDayLabel(first.date)} · {formatMoney(first.cashUsdMinor, 'USD', { compact: true })}
        </span>
        <span className="faint text-[11px]">
          range {formatMoney(min, 'USD', { compact: true })} – {formatMoney(max, 'USD', { compact: true })}
        </span>
        <span className="tabular text-[11px] font-medium" style={{ color: stroke }}>
          {formatDayLabel(last.date)} · {formatMoney(last.cashUsdMinor, 'USD', { compact: true })}
        </span>
      </div>
    </div>
  );
}
