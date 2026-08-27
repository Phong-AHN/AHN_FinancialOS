#!/usr/bin/env node
/**
 * Scheduler worker.
 *
 * Calls the app's own `/api/cron/*` endpoints on a schedule. It holds no
 * business logic and touches no database — every decision still lives in the
 * app, exactly as it did under Vercel Cron. This process only decides *when*.
 *
 * WHY IT EXISTS
 *
 * Vercel's Hobby plan allows one cron run per day. The sync needs to run every
 * ten minutes to make "every dollar, within a few minutes" true, so the
 * schedule moved to a host without that limit.
 *
 * WHY A LONG-RUNNING LOOP RATHER THAN THE HOST'S CRON
 *
 * A self-contained scheduler runs the same way on Railway, Render, Fly or a
 * plain VPS. Nothing here depends on one provider's cron syntax, quotas or
 * minimum interval, so moving hosts again costs nothing.
 *
 * Required environment:
 *   APP_URL       https://your-app.vercel.app   (no trailing slash needed)
 *   CRON_SECRET   the same value the app has — the endpoints reject anything else
 *
 * Optional:
 *   SYNC_INTERVAL_MINUTES  default 10
 *   DIGEST_HOUR            local hour for the daily digest, default 9
 *   WEEKLY_DIGEST_DAY      0=Sunday … 1=Monday (default)
 *   TZ                     e.g. Asia/Ho_Chi_Minh — decides what "9am" means
 *   PORT                   health endpoint, default 8080
 */

import { createServer } from 'node:http';

const APP_URL = (process.env.APP_URL ?? '').replace(/\/$/, '');
const CRON_SECRET = process.env.CRON_SECRET ?? '';
const SYNC_INTERVAL_MINUTES = clampNumber(process.env.SYNC_INTERVAL_MINUTES, 10, 1, 1440);
const DIGEST_HOUR = clampNumber(process.env.DIGEST_HOUR, 9, 0, 23);
const WEEKLY_DIGEST_DAY = clampNumber(process.env.WEEKLY_DIGEST_DAY, 1, 0, 6);
const PORT = clampNumber(process.env.PORT, 8080, 1, 65535);

if (!APP_URL || !CRON_SECRET) {
  console.error(
    'APP_URL and CRON_SECRET are both required.\n' +
      'CRON_SECRET must match the value the app is running with, or every call is rejected.',
  );
  process.exit(1);
}

/** Last outcome per job, surfaced on /health so a silent failure is visible. */
const state = {
  startedAt: new Date().toISOString(),
  jobs: {
    sync: { runs: 0, failures: 0, lastRun: null, lastStatus: null, lastError: null },
    'digest:daily': { runs: 0, failures: 0, lastRun: null, lastStatus: null, lastError: null },
    'digest:weekly': { runs: 0, failures: 0, lastRun: null, lastStatus: null, lastError: null },
    'price-increases': { runs: 0, failures: 0, lastRun: null, lastStatus: null, lastError: null },
  },
};

/**
 * The timezone the process is ACTUALLY using.
 *
 * Not `process.env.TZ`. That variable is what someone *asked* for, it is not
 * always readable back (it comes through undefined on Windows, and a host may
 * set the zone by other means), and it is not what `Date#getHours` consults.
 * The digest fires on `getHours`, so the health report has to name the zone
 * that governs it — otherwise it answers "is my digest firing at 9am in
 * Vietnam?" with an echo of a variable rather than the truth.
 */
function resolvedTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function clampNumber(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function log(...parts) {
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

/**
 * Call one endpoint.
 *
 * Never throws. A scheduler that dies on a bad response stops scheduling
 * everything else, and the failure that killed it is the one nobody sees.
 */
async function callEndpoint(job, path) {
  const entry = (state.jobs[job] ??= {
    runs: 0,
    failures: 0,
    lastRun: null,
    lastStatus: null,
    lastError: null,
  });
  entry.runs++;
  entry.lastRun = new Date().toISOString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    const res = await fetch(`${APP_URL}${path}`, {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
      signal: controller.signal,
    });

    const body = await res.text();
    entry.lastStatus = res.status;

    if (!res.ok) {
      entry.failures++;
      entry.lastError = `${res.status} ${body.slice(0, 200)}`;
      log(`${job} FAILED  ${res.status}  ${body.slice(0, 200)}`);
      return;
    }

    entry.lastError = null;
    log(`${job} ok  ${summarise(body)}`);
  } catch (err) {
    entry.failures++;
    entry.lastError = err.name === 'AbortError' ? 'timeout after 120s' : err.message;
    log(`${job} FAILED  ${entry.lastError}`);
  } finally {
    clearTimeout(timeout);
  }
}

/** Pull the interesting numbers out of the response rather than dumping JSON. */
function summarise(body) {
  try {
    const j = JSON.parse(body);
    const bits = [];
    if (Array.isArray(j.sync)) {
      const inserted = j.sync.reduce((s, r) => s + (r.inserted ?? 0), 0);
      const failed = j.sync.filter((r) => r.error);
      bits.push(`${inserted} new`);
      if (failed.length) bits.push(`${failed.map((f) => `${f.provider}: ${f.error}`).join('; ')}`);
    }
    if (j.dedup?.flagged) bits.push(`${j.dedup.flagged} duplicates flagged`);
    if (j.alerts) {
      if (j.alerts.transactionsAlerted) bits.push(`${j.alerts.transactionsAlerted} alerted`);
      if (j.alerts.suppressedAsBackfill) bits.push(`${j.alerts.suppressedAsBackfill} backfill suppressed`);
      if (j.alerts.failed) bits.push(`${j.alerts.failed} deliveries failed`);
    }
    if (typeof j.sent === 'number') bits.push(`${j.sent} sent`);
    return bits.join(', ') || 'nothing to do';
  } catch {
    return body.slice(0, 120);
  }
}

// ─── Schedule ───────────────────────────────────────────────────────────────

const syncMs = SYNC_INTERVAL_MINUTES * 60_000;
setInterval(() => void callEndpoint('sync', '/api/cron/sync'), syncMs);
// Run once at boot so a deploy does not wait a full interval for the first pull.
void callEndpoint('sync', '/api/cron/sync');

/**
 * Digests fire on a wall-clock hour, so the loop checks every minute rather
 * than counting intervals: a container restart must not shift the daily digest,
 * and an interval-based schedule drifts every time the process is redeployed.
 *
 * `lastFiredKey` makes each digest at-most-once per day, so a restart inside
 * the digest hour does not send it twice.
 */
let lastDailyKey = null;
let lastWeeklyKey = null;

setInterval(() => {
  const now = new Date();
  if (now.getHours() !== DIGEST_HOUR || now.getMinutes() !== 0) return;

  const dayKey = now.toISOString().slice(0, 10);

  if (lastDailyKey !== dayKey) {
    lastDailyKey = dayKey;
    void callEndpoint('digest:daily', '/api/cron/digest?period=daily');
  }

  if (now.getDay() === WEEKLY_DIGEST_DAY && lastWeeklyKey !== dayKey) {
    lastWeeklyKey = dayKey;
    void callEndpoint('digest:weekly', '/api/cron/digest?period=weekly');
  }
}, 60_000);

/**
 * The price-increase sweep, once a day, an hour after the digest.
 *
 * Kept off the sync tick deliberately: it re-reads three years of outflows to
 * rebuild the recurring-charge picture, and a price changes monthly at most.
 * Running it every few minutes would spend most of the sync budget rediscovering
 * the same answer. It is deduped by vendor and change date, so firing once a day
 * still announces every rise exactly once.
 *
 * An hour after the digest so the two never contend for the same minute.
 */
let lastPriceKey = null;

setInterval(() => {
  const now = new Date();
  if (now.getHours() !== (DIGEST_HOUR + 1) % 24 || now.getMinutes() !== 0) return;

  const dayKey = now.toISOString().slice(0, 10);
  if (lastPriceKey === dayKey) return;
  lastPriceKey = dayKey;
  void callEndpoint('price-increases', '/api/cron/price-increases');
}, 60_000);

// ─── Health ─────────────────────────────────────────────────────────────────

createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const unhealthy = Object.values(state.jobs).some(
      (j) => j.runs > 0 && j.lastError !== null,
    );
    res.writeHead(unhealthy ? 503 : 200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        {
          ok: !unhealthy,
          target: APP_URL,
          syncEveryMinutes: SYNC_INTERVAL_MINUTES,
          digestHour: DIGEST_HOUR,
          weeklyDigestDay: WEEKLY_DIGEST_DAY,
          // What the scheduler is really using, not what TZ was set to.
          timezone: resolvedTimeZone(),
          nextDigestLocalTime: `${String(DIGEST_HOUR).padStart(2, '0')}:00 ${resolvedTimeZone()}`,
          localTimeNow: new Date().toString(),
          ...state,
        },
        null,
        2,
      ),
    );
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, () => {
  log(
    `scheduler up — ${APP_URL}, sync every ${SYNC_INTERVAL_MINUTES}m, ` +
      `digest at ${String(DIGEST_HOUR).padStart(2, '0')}:00 ${resolvedTimeZone()}, ` +
      `health on :${PORT}`,
  );
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log(`${signal} — shutting down`);
    process.exit(0);
  });
}
