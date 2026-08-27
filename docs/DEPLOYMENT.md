# Deployment

Two pieces, deployed separately:

| | Where | What it does |
|---|---|---|
| **The app** | Vercel | Next.js — dashboard, API routes, `/api/cron/*` endpoints |
| **The scheduler** | Railway | Calls those cron endpoints on a schedule |

## Why the scheduler is not on Vercel

Vercel's Hobby plan allows **one cron run per day**:

> Hobby accounts are limited to daily cron jobs. This cron expression
> (`*/10 * * * *`) would run more than once per day.

The sync needs to run every ten minutes, or "every dollar, within a few minutes"
is not true. The schedule therefore lives in
[`worker/index.mjs`](../worker/index.mjs), deployed separately.

Nothing else changed. The `/api/cron/*` endpoints are identical and still
guarded by `CRON_SECRET`; the worker is only a caller.

**There is no `vercel.json`.** It held nothing but the crons, and Vercel's schema
rejects unknown keys (`should NOT have additional property "comment"`) so the
explanation could not live there either. Everything else it might have carried is
already elsewhere: `maxDuration` is declared per route with
`export const maxDuration = 60`, and the security headers are in
`next.config.mjs`.

### Region: put the app next to the database

`vercel.json` pins the deployment to **`hnd1` (Tokyo)** because the Supabase
project lives in **`aws-0-ap-northeast-1`**, which is also Tokyo. This is not a
preference. It is the single largest thing affecting how fast the app feels.

Measured from Vietnam against the Tokyo database, one round trip costs about
**145ms** — an empty `select * from companies` takes that long, and so does
anything else, because the time is distance, not work. A page that makes four
sequential round trips spends 580ms waiting on the network and a few
milliseconds computing.

Vercel defaults to `iad1` (Washington DC). Left alone, every query would travel
Washington → Tokyo → Washington, and every page would travel Vietnam →
Washington on top of that. The app would be slower deployed than it is running
on a laptop in Hanoi.

With the app in Tokyo the shape inverts:

| | Server in Washington (default) | Server in Tokyo (`hnd1`) |
|---|---|---|
| Server → database, per query | ~170ms | ~1–5ms |
| Person → server, per page | ~230ms | ~60ms |
| A page making 4 queries | ~910ms | ~80ms |

The queries stop mattering; only the one hop from the reader to the server does.

**Set the Railway worker to Tokyo as well** (Settings → Region). It calls the
app's own `/api/cron/*` endpoints, so a worker on another continent pays the
same tax on every scheduled run.

If AHN later moves the Supabase project closer to Vietnam — Singapore
(`ap-southeast-1`) is the nearest region — move the Vercel region to `sin1` in
the same change. The rule is that the app and the database share a region; which
region they share matters far less.

## Moving back to Vercel Cron on a Pro plan

Add the `crons` block to the existing `vercel.json` — keep the `regions`
setting — and stop the Railway service:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["hnd1"],
  "crons": [
    { "path": "/api/cron/sync", "schedule": "*/10 * * * *" },
    { "path": "/api/cron/digest?period=daily", "schedule": "0 2 * * *" },
    { "path": "/api/cron/digest?period=weekly", "schedule": "0 2 * * 1" },
    { "path": "/api/cron/price-increases", "schedule": "0 3 * * *" }
  ]
}
```

The price-increase sweep is deliberately its own daily job rather than part of
the sync. It re-reads three years of outflows to rebuild the recurring-charge
picture, and a price changes monthly at most; folding it into a ten-minute tick
would spend most of that tick's 60-second budget rediscovering the same answer,
and a slow run would take the ordinary money-in and money-out alerts down with
it. It deduplicates by vendor and change date, so running once a day still
announces every rise exactly once.

Vercel cron schedules are **UTC and not configurable**, so `0 2 * * *` is 09:00
in Vietnam. That is the one thing the Railway worker does better: it takes a `TZ`
and fires on local time.

The worker is a plain interval loop rather than Railway's own cron feature, so it
runs the same way on Railway, Render, Fly or a VPS. No provider's cron syntax,
quota or minimum interval is baked in.

---

## 1. Deploy the app to Vercel

Set these in **Project Settings → Environment Variables**. `.env.local` is not
uploaded — Vercel needs its own copy.

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
ENCRYPTION_KEY
CRON_SECRET
NEXT_PUBLIC_APP_URL        https://your-app.vercel.app   ← alert deep links use this
QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_ENVIRONMENT / QBO_REDIRECT_URI
PLAID_CLIENT_ID / PLAID_SECRET / PLAID_ENV
SLACK_BOT_TOKEN
SLACK_DEFAULT_CHANNEL      "#ahn-finance-alerts"   ← quote it, see below
SLACK_CHANNEL_CRITICAL / SLACK_CHANNEL_WARNING / SLACK_CHANNEL_DIGEST
```

> **Quote every channel name.** An unquoted value starting with `#` is read as a
> comment and arrives empty, which silently drops the app back to the incoming
> webhook — one channel for everything, and messages the bot cannot delete. This
> cost real debugging time once already (decision 35).

`ENCRYPTION_KEY` must be **the same value** as the one the tokens were encrypted
with, or every stored OAuth token becomes unreadable and the integrations have to
be reconnected.

After deploying, update the redirect URI on the Intuit app to the production URL
and set `QBO_REDIRECT_URI` to match.

---

## 2. Deploy the scheduler to Railway

New project → **Deploy from GitHub repo** → this repository.

### Settings

| Setting | Value | Why |
|---|---|---|
| **Root Directory** | `worker` | The only setting that is not optional. Without it Railway builds from the repo root, installs Next.js, React and everything else for a worker that imports one Node built-in — and Nixpacks, seeing a Next.js app, may try `next build`, which needs the app's environment and fails confusingly. |
| **Start Command** | *(leave blank)* | [`worker/railway.json`](../worker/railway.json) sets `node index.mjs`. |
| **Healthcheck Path** | *(leave blank)* | Same file sets `/health`. |
| **Builder** | Nixpacks (default) | |
| **Public Networking** | enable | So `/health` is reachable. Nothing else is served. |

[`worker/`](../worker/) is self-contained — its own `package.json` with **zero
dependencies** and its own `railway.json`. `npm install` there is instant, and
the worker cannot accidentally reach into application code.

[`.railwayignore`](../.railwayignore) keeps the upload to `worker/` alone.
Railway uploads the whole repository before building from the Root Directory, so
without it the app's `package-lock.json` travels along — and Railway's dependency
scanner reads that lockfile and blocks the build over advisories in packages the
worker never loads.

### Variables

Add these under **Variables**:

| Variable | Value | |
|---|---|---|
| `APP_URL` | `https://your-app.vercel.app` | required |
| `CRON_SECRET` | **the same string the app has** | required |
| `SYNC_INTERVAL_MINUTES` | `10` | optional |
| `DIGEST_HOUR` | `9` | optional, local hour |
| `WEEKLY_DIGEST_DAY` | `1` (Monday) | optional |
| `TZ` | `Asia/Ho_Chi_Minh` | optional — decides what "9am" means |

Without `TZ` the container runs UTC, so a `DIGEST_HOUR` of 9 fires at 16:00 in
Vietnam. Set it deliberately.

Do not set `PORT` — Railway assigns it, and the worker reads it.

`/health` reports the timezone the process is **actually** resolved to, not the
value of `TZ`. Those can differ, and the one that decides when the digest fires
is the resolved zone:

```json
{ "timezone": "Asia/Ho_Chi_Minh", "nextDigestLocalTime": "09:00 Asia/Ho_Chi_Minh" }
```

The worker needs no database access, no Supabase keys and no provider
credentials. It knows a URL and a shared secret, and nothing else — so a
compromise of the scheduler exposes far less than a compromise of the app.

### Confirming it works

`https://<worker>.up.railway.app/health` returns the state of each job:

```json
{
  "ok": true,
  "target": "https://your-app.vercel.app",
  "syncEveryMinutes": 10,
  "jobs": {
    "sync": { "runs": 42, "failures": 0, "lastRun": "…", "lastStatus": 200, "lastError": null }
  }
}
```

It answers **503** once any job has failed, so Railway's health check restarts a
worker that has lost the app rather than leaving it quietly dead. A wrong
`CRON_SECRET` shows up immediately:

```
sync FAILED  401  {"error":"Unauthorized."}
```

The logs summarise each run rather than dumping JSON:

```
sync ok  3 new, 1 duplicates flagged, 3 alerted
sync ok  nothing to do
```

---

## 3. Verify the whole deployment

```bash
npm run smoke -- you@example.com 'password' https://your-app.vercel.app
```

Signs in and loads every page as a real owner. Nothing else in the test suite
does this — the unit and integration tests call the calc engine directly, so a
page that throws while rendering those numbers passes all of them, and
`next build` misses it too because every page is server-rendered on demand.

---

## Before the first real sync

- **Clear the demo data**: `npm run db:seed -- --reset --reset-only`. It removes
  only what the seeder wrote — rows keyed `demo-%` and the accounts it created,
  including their reported balances. Real connector data is untouched.
- **Check `ALERT_MAX_AGE_DAYS`** (default 3). The first sync of a source
  backfills ~180 days; without the horizon that is hundreds of alerts in one
  burst about money that moved months ago. Older rows are still ingested and
  still counted — they are marked as seen rather than announced.
- **Run the migrations** against the production database: `npm run db:push`, or
  paste `supabase/setup-all.sql` into the Supabase SQL editor.
