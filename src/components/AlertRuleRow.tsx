'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { formatMoney } from '@/lib/money';
import { SeverityBadge } from '@/components/ui';
import type { AlertRule, NotificationChannel } from '@/lib/types';

const ALL_CHANNELS: NotificationChannel[] = ['slack', 'email', 'sms', 'in_app'];

/**
 * One configurable alert rule - Spec section 4 ("users must be able to
 * configure alerts by ... amount, inflow/outflow, ...") and section 6 (channels
 * enabled independently).
 *
 * `in_app` is always on and not offered as a choice: the notification row is
 * the in-app delivery, and it is also the delivery log, so switching it off
 * would mean an alert that fired with no record that it did.
 */
export function AlertRuleRow({
  rule,
  canEdit,
  channelStatus,
}: {
  rule: AlertRule;
  canEdit: boolean;
  channelStatus: Record<string, boolean>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState({
    enabled: rule.enabled,
    channels: rule.channels,
    threshold: rule.threshold_minor,
    thresholdNumber: rule.threshold_number,
  });

  async function save(patch: Partial<typeof state>) {
    const next = { ...state, ...patch };
    setState(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/alert-rules/${rule.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: next.enabled,
          channels: next.channels,
          threshold_minor: next.threshold,
          threshold_number: next.thresholdNumber,
        }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: string };
        setError(json.error ?? 'Could not save.');
        setState(state);
      } else {
        startTransition(() => router.refresh());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
      setState(state);
    } finally {
      setSaving(false);
    }
  }

  function toggleChannel(channel: NotificationChannel) {
    const has = state.channels.includes(channel);
    void save({
      channels: has ? state.channels.filter((c) => c !== channel) : [...state.channels, channel],
    });
  }

  // A price increase is the only rule with TWO floors, and both have to clear
  // before it fires: the percentage keeps a 3% rise on a big bill out, and the
  // annual cost keeps a 40% rise on a $4 tool out. Rendering only one of them
  // would ship a threshold the owner is told to tune and cannot reach.
  const isPriceRule = rule.type === 'price_increase';
  const usesMoneyThreshold =
    rule.type === 'large_outflow' || rule.type === 'low_balance' || isPriceRule;
  const usesNumberThreshold = rule.type === 'low_runway' || isPriceRule;

  return (
    <tr style={{ opacity: state.enabled ? 1 : 0.55 }}>
      <td>
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={state.enabled}
            disabled={!canEdit || saving}
            onChange={(e) => save({ enabled: e.target.checked })}
            className="mt-0.5 accent-[var(--brand)]"
            style={{ width: 16, height: 16 }}
          />
          <span>
            <span className="font-medium">{rule.name}</span>
            <span className="faint block text-[11.5px]">
              {String((rule.config as { description?: string }).description ?? rule.type)}
            </span>
            {error && (
              <span className="block text-[11.5px]" style={{ color: 'var(--outflow)' }}>
                {error}
              </span>
            )}
          </span>
        </label>
      </td>

      <td>
        <SeverityBadge severity={rule.severity} />
      </td>

      <td>
        {usesMoneyThreshold && (
          <input
            type="text"
            disabled={!canEdit || saving}
            defaultValue={state.threshold === null ? '' : String(state.threshold / 100)}
            placeholder={isPriceRule ? 'USD/yr' : 'USD'}
            title={isPriceRule ? 'Least extra annual cost worth an alert' : undefined}
            style={{ width: 110 }}
            onBlur={(e) => {
              const value = e.target.value.replace(/[^0-9.]/g, '');
              const minor = value ? Math.round(Number(value) * 100) : null;
              if (minor !== state.threshold) void save({ threshold: minor });
            }}
          />
        )}
        {usesNumberThreshold && (
          <input
            type="text"
            disabled={!canEdit || saving}
            defaultValue={
              state.thresholdNumber === null
                ? ''
                : String(isPriceRule ? Math.round(state.thresholdNumber * 100) : state.thresholdNumber)
            }
            placeholder={isPriceRule ? '% rise' : 'months'}
            title={isPriceRule ? 'Smallest rise worth an alert, as a percentage' : undefined}
            style={{ width: 110 }}
            onBlur={(e) => {
              const value = e.target.value.replace(/[^0-9.]/g, '');
              // Stored as a ratio, shown as a percentage. Writing back the
              // typed number unchanged would read "10" as a 1,000% floor and
              // silently switch the rule off.
              const num = value ? (isPriceRule ? Number(value) / 100 : Number(value)) : null;
              if (num !== state.thresholdNumber) void save({ thresholdNumber: num });
            }}
          />
        )}
        {!usesMoneyThreshold && !usesNumberThreshold && (
          <span className="faint text-[12px]">
            {rule.threshold_minor ? `over ${formatMoney(rule.threshold_minor)}` : 'any amount'}
          </span>
        )}
      </td>

      <td>
        <div className="flex flex-wrap gap-3">
          {ALL_CHANNELS.filter((c) => c !== 'in_app').map((channel) => {
            const on = state.channels.includes(channel);
            const configured = channelStatus[channel];
            return (
              <label key={channel} className="flex items-center gap-1.5 text-[12px]">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!canEdit || saving}
                  onChange={() => toggleChannel(channel)}
                  className="accent-[var(--brand)]"
                  style={{ width: 15, height: 15 }}
                />
                <span
                  className="capitalize"
                  title={configured ? undefined : `${channel} credentials are not set — this alert will be recorded as skipped.`}
                  style={{ color: on && !configured ? 'var(--warn)' : undefined }}
                >
                  {channel}
                  {on && !configured && ' ⚠'}
                </span>
              </label>
            );
          })}
        </div>
      </td>
    </tr>
  );
}
