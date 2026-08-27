import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatMoney } from '@/lib/money';
import type { AlertSeverity, ReconStatus } from '@/lib/types';

// ─── Layout primitives ──────────────────────────────────────────────────────

export function Card({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return <div className={`card ${padded ? 'p-5' : ''} ${className}`}>{children}</div>;
}

export function SectionHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {subtitle && <p className="muted mt-0.5 text-[12.5px]">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="muted mt-1 text-[13px]">{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <p className="text-[14px] font-semibold">{title}</p>
      <p className="muted max-w-md text-[13px] leading-relaxed">{body}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

// ─── Stat tile ──────────────────────────────────────────────────────────────

/**
 * The dashboard headline number.
 *
 * `href` is not decoration: spec section 22 requires every number on a
 * dashboard to be drillable to the transactions that produced it, so a tile
 * without a destination is a tile that fails the acceptance criteria.
 */
export function StatTile({
  label,
  value,
  hint,
  href,
  tone = 'neutral',
  emphasis = false,
}: {
  label: string;
  value: string;
  hint?: string;
  href?: string;
  tone?: 'neutral' | 'inflow' | 'outflow' | 'warn';
  emphasis?: boolean;
}) {
  const toneColor = {
    neutral: 'var(--text)',
    inflow: 'var(--inflow)',
    outflow: 'var(--outflow)',
    warn: 'var(--warn)',
  }[tone];

  const inner = (
    <>
      <p className="faint text-[11px] font-semibold uppercase tracking-[0.05em]">{label}</p>
      <p
        className={`tabular mt-2 font-semibold tracking-tight ${emphasis ? 'text-[30px]' : 'text-[22px]'}`}
        style={{ color: toneColor }}
      >
        {value}
      </p>
      {hint && <p className="muted mt-1.5 text-[12px] leading-snug">{hint}</p>}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="card block p-5 transition-colors hover:border-[var(--line-strong)]"
      >
        {inner}
      </Link>
    );
  }
  return <div className="card p-5">{inner}</div>;
}

// ─── Money ──────────────────────────────────────────────────────────────────

export function Money({
  minor,
  currency = 'USD',
  signed = false,
  direction,
  className = '',
}: {
  minor: number | null | undefined;
  currency?: string;
  signed?: boolean;
  direction?: 'inflow' | 'outflow';
  className?: string;
}) {
  const color =
    direction === 'inflow'
      ? 'var(--inflow)'
      : direction === 'outflow'
        ? 'var(--outflow)'
        : undefined;
  const text =
    direction === 'outflow'
      ? `−${formatMoney(minor, currency).replace(/^[−-]/, '')}`
      : formatMoney(minor, currency, { signed: signed || direction === 'inflow' });

  return (
    <span className={`tabular ${className}`} style={color ? { color } : undefined}>
      {text}
    </span>
  );
}

// ─── Badges ─────────────────────────────────────────────────────────────────

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'inflow' | 'outflow' | 'warn' | 'brand';
  title?: string;
}) {
  const styles: Record<string, { bg: string; fg: string }> = {
    neutral: { bg: 'var(--surface-sunk)', fg: 'var(--text-muted)' },
    inflow: { bg: 'var(--inflow-soft)', fg: 'var(--inflow)' },
    outflow: { bg: 'var(--outflow-soft)', fg: 'var(--outflow)' },
    warn: { bg: 'var(--warn-soft)', fg: 'var(--warn)' },
    brand: { bg: 'var(--brand-soft)', fg: 'var(--brand)' },
  };
  const s = styles[tone] ?? styles.neutral!;
  return (
    <span
      title={title}
      className="inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ background: s.bg, color: s.fg }}
    >
      {children}
    </span>
  );
}

const RECON_LABELS: Record<ReconStatus, { label: string; tone: 'neutral' | 'warn' | 'inflow' }> = {
  unreconciled: { label: 'Unreconciled', tone: 'neutral' },
  matched: { label: 'Matched', tone: 'inflow' },
  possible_duplicate: { label: 'Possible duplicate', tone: 'warn' },
  duplicate_ignored: { label: 'Duplicate (excluded)', tone: 'warn' },
  reconciled: { label: 'Reconciled', tone: 'inflow' },
};

export function ReconBadge({ status }: { status: ReconStatus }) {
  const meta = RECON_LABELS[status];
  return (
    <Badge tone={meta.tone} title={statusHelp(status)}>
      {meta.label}
    </Badge>
  );
}

function statusHelp(status: ReconStatus): string {
  switch (status) {
    case 'possible_duplicate':
      return 'Held out of cash totals until someone confirms whether it is a duplicate.';
    case 'duplicate_ignored':
      return 'Confirmed duplicate. Excluded from all totals.';
    case 'matched':
      return 'Matched to the same activity in another source.';
    case 'reconciled':
      return 'Confirmed against the bank.';
    default:
      return 'Not yet reviewed.';
  }
}

export function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  const map: Record<AlertSeverity, { tone: 'neutral' | 'warn' | 'outflow' | 'brand'; label: string }> = {
    info: { tone: 'brand', label: 'Info' },
    warning: { tone: 'warn', label: 'Warning' },
    critical: { tone: 'outflow', label: 'Critical' },
    digest: { tone: 'neutral', label: 'Digest' },
  };
  const meta = map[severity];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

// ─── Buttons ────────────────────────────────────────────────────────────────

export function buttonClass(variant: 'primary' | 'secondary' | 'danger' = 'secondary'): string {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  if (variant === 'primary') return `${base} bg-[var(--brand)] text-white hover:opacity-90`;
  if (variant === 'danger') return `${base} bg-[var(--outflow)] text-white hover:opacity-90`;
  return `${base} border border-[var(--line-strong)] hover:bg-[var(--surface-sunk)]`;
}

export function LinkButton({
  href,
  children,
  variant = 'secondary',
}: {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  return (
    <Link href={href} className={buttonClass(variant)}>
      {children}
    </Link>
  );
}

// ─── Callouts ───────────────────────────────────────────────────────────────

export function Callout({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: 'neutral' | 'warn' | 'outflow' | 'brand';
  title?: string;
  children: ReactNode;
}) {
  const bg = {
    neutral: 'var(--surface-sunk)',
    warn: 'var(--warn-soft)',
    outflow: 'var(--outflow-soft)',
    brand: 'var(--brand-soft)',
  }[tone];
  const fg = {
    neutral: 'var(--line-strong)',
    warn: 'var(--warn)',
    outflow: 'var(--outflow)',
    brand: 'var(--brand)',
  }[tone];

  return (
    <div
      className="rounded-lg border-l-[3px] px-4 py-3 text-[13px] leading-relaxed"
      style={{ background: bg, borderLeftColor: fg }}
    >
      {title && <p className="mb-1 font-semibold">{title}</p>}
      <div className="muted">{children}</div>
    </div>
  );
}

/**
 * Shown wherever a number depends on a formula the reader might reasonably
 * question. Spec section 20 draws a hard line between deterministic math and AI
 * interpretation; making the formula visible is how the reader can tell which
 * one they are looking at.
 */
export function FormulaNote({ children }: { children: ReactNode }) {
  return (
    <p className="faint mt-3 border-t border-[var(--line)] pt-3 text-[11.5px] leading-relaxed">
      {children}
    </p>
  );
}
