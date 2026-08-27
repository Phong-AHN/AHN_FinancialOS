#!/usr/bin/env node
/**
 * Apply the SQL migrations, and optionally load demo data.
 *
 *   npm run db:push     # 11 tables + RLS + default alert rules
 *
 * Demo data is loaded separately by `npm run db:seed`, which needs only the
 * REST credentials - see scripts/seed.mjs.
 *
 * Needs SUPABASE_DB_URL - the direct Postgres connection string from Supabase
 * (Project Settings -> Database -> Connection string -> URI). The anon and
 * service-role keys cannot run DDL.
 *
 * Everything is idempotent, so re-running is safe.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations');

await loadEnv();

const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error(
    '\n  SUPABASE_DB_URL is not set.\n\n' +
      '  Supabase dashboard -> Project Settings -> Database -> Connection string -> URI\n' +
      '  Add it to .env.local, then run this again.\n',
  );
  process.exit(1);
}

const wantsSeed = process.argv.includes('--seed');
const client = new pg.Client({
  connectionString,
  ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false },
});

try {
  await client.connect();
  console.log('Connected.\n');

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    process.stdout.write(`  ${file} … `);
    await client.query(sql);
    console.log('ok');
  }

  if (wantsSeed) {
    // Seeding runs over the REST client rather than this Postgres connection,
    // so it lives in its own entry point and still works where Supabase's
    // direct Postgres host is unreachable (it is IPv6-only on many projects).
    console.log('\nMigrations applied. Run `npm run db:seed` to load demo data.');
  }

  console.log('\nDone.');
} catch (err) {
  console.error(`\nFailed: ${err.message}\n`);
  if (err.code === 'ENOTFOUND' || err.code === 'ENETUNREACH') {
    console.error(
      [
        "  That is Supabase's direct host. It publishes only an IPv6 address, and",
        '  this network has no IPv6 route to it.',
        '',
        '  Looking for the pooler, which is reachable over IPv4 and takes the same',
        '  password...',
        '',
      ].join('\n'),
    );

    const pooler = await findPoolerUrl(connectionString);
    if (pooler) {
      console.error(`  Reachable at ${pooler.host}. Retrying...\n`);
      const retryClient = new pg.Client({
        connectionString: pooler.url,
        ssl: { rejectUnauthorized: false },
      });
      try {
        await retryClient.connect();
        const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
        for (const file of files) {
          const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
          process.stdout.write(`  ${file} ... `);
          await retryClient.query(sql);
          console.log('ok');
        }
        await retryClient.end();
        console.log('\nDone.\n');
        console.log('  Save this in .env.local so the next run goes straight there:');
        console.log(`    SUPABASE_DB_URL=postgresql://postgres.<ref>:<pw>@${pooler.host}:5432/postgres\n`);
        process.exitCode = 0;
        process.exit(0);
      } catch (retryError) {
        console.error(`  Pooler attempt failed too: ${retryError.message}\n`);
      }
    } else {
      console.error(
        [
          '  No pooler region accepted these credentials.',
          '',
          '  Copy the "Session pooler" URI from Supabase -> Project Settings ->',
          '  Database -> Connection string, or paste supabase/setup-all.sql into',
          '  the SQL editor instead. Every statement is idempotent.',
          '',
        ].join('\n'),
      );
    }
  }
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

/**
 * Supabase's direct host `db.<ref>.supabase.co` publishes only an AAAA record.
 * On an IPv4-only network it is simply unreachable, and the error says nothing
 * about why — it took a manual region hunt to work that out once already.
 *
 * The pooler is reachable over IPv4 and takes the SAME password, with the user
 * rewritten to `postgres.<ref>`. Only the region is unknown, so this probes the
 * candidates and returns the first that authenticates.
 */
async function findPoolerUrl(directUrl) {
  const u = new URL(directUrl);
  const ref = u.hostname.split('.')[1];
  const password = decodeURIComponent(u.password);
  if (!ref || !password) return null;

  const regions = [
    'ap-southeast-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-southeast-2',
    'ap-south-1', 'us-east-1', 'us-east-2', 'us-west-1', 'eu-central-1',
    'eu-west-1', 'eu-west-2', 'sa-east-1', 'ca-central-1',
  ];

  process.stdout.write('  probing pooler regions ');
  for (const region of regions) {
    for (const prefix of ['aws-0', 'aws-1']) {
      const host = `${prefix}-${region}.pooler.supabase.com`;
      const candidate = `postgresql://postgres.${ref}:${encodeURIComponent(password)}@${host}:5432/postgres`;
      const probe = new pg.Client({
        connectionString: candidate,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 8000,
      });
      try {
        await probe.connect();
        await probe.end();
        process.stdout.write(' found\n');
        return { url: candidate, host };
      } catch {
        try { await probe.end(); } catch {}
      }
    }
    process.stdout.write('.');
  }
  process.stdout.write(' none\n');
  return null;
}

/** Minimal .env.local reader so the script needs no dotenv dependency. */
async function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    try {
      const text = await readFile(join(__dirname, '..', file), 'utf8');
      for (const line of text.split('\n')) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!match) continue;
        const [, key, rawValue] = match;
        if (process.env[key]) continue;
        process.env[key] = rawValue.replace(/^["']|["']$/g, '');
      }
    } catch {
      // File is optional.
    }
  }
}
