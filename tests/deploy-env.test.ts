import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Every environment variable the app reads is documented where somebody
 * deploying it will look.
 *
 * WHY. `docs/DEPLOYMENT.md` told you to set seventeen variables. The app reads
 * forty-nine. `STRIPE_SECRET_KEY` was missing while Stripe was a live, syncing
 * integration — a deployment following that page would have had a silently
 * broken sync and no error to point at. `SLACK_SIGNING_SECRET` would have made
 * every slash command refuse, and an absent `BUSINESS_TIME_ZONE` reverts
 * "today" to UTC, which names the wrong day for seven hours of every Vietnamese
 * day.
 *
 * A missing variable is the quietest kind of production failure: nothing throws,
 * a feature just does not happen.
 */
const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * Variables the Railway worker owns, documented in its own section.
 * `NODE_ENV` is set by Node itself.
 */
const WORKER_OR_RUNTIME = new Set([
  'APP_URL',
  'DIGEST_HOUR',
  'PORT',
  'SYNC_INTERVAL_MINUTES',
  'TZ',
  'WEEKLY_DIGEST_DAY',
  'NODE_ENV',
]);

/** Read by local tooling only; the deployed app never uses it. */
const LOCAL_TOOLING = new Set(['SUPABASE_DB_URL']);

function envVarsReadByCode(): string[] {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
        for (const m of read(rel).matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
          found.add(m[1]!);
        }
      }
    }
  };
  walk('src');
  return [...found].sort();
}

describe('deployment documentation', () => {
  const used = envVarsReadByCode();
  const example = read('.env.example');
  const deployment = read('docs/DEPLOYMENT.md');

  it('reads a plausible number of variables', () => {
    // A guard on the guard: if the scan breaks, the assertions below all pass
    // vacuously and this file becomes decoration.
    expect(used.length).toBeGreaterThan(30);
  });

  it('documents every variable in .env.example', () => {
    const missing = used.filter(
      (v) =>
        !WORKER_OR_RUNTIME.has(v) &&
        !new RegExp(`^${v}=`, 'm').test(example),
    );
    expect(missing, 'read by the app but absent from .env.example').toEqual([]);
  });

  it('names every variable in the deployment guide', () => {
    // The one that was actually wrong. `.env.example` was complete; the page
    // somebody follows when deploying was not.
    const missing = used.filter(
      (v) =>
        !WORKER_OR_RUNTIME.has(v) &&
        !LOCAL_TOOLING.has(v) &&
        !deployment.includes(v),
    );
    if (missing.length > 0) {
      console.log('\n  Read by the app, not mentioned in docs/DEPLOYMENT.md:');
      for (const v of missing) console.log(`    ${v}`);
    }
    expect(missing, 'a deployment following the guide would be missing these').toEqual([]);
  });

  it('still explains the worker variables in the guide', () => {
    for (const v of ['APP_URL', 'CRON_SECRET', 'TZ', 'DIGEST_HOUR']) {
      expect(deployment, `${v} is not in the deployment guide`).toContain(v);
    }
  });
});
