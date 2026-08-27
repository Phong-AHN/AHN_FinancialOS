#!/usr/bin/env node
/**
 * Concatenate the migrations into one paste-ready file.
 *
 *   node scripts/bundle-sql.mjs   ->  supabase/setup-all.sql
 *
 * `npm run db:push` is the better path, but it needs SUPABASE_DB_URL (the direct
 * Postgres connection string), which not every setup has to hand. This produces
 * a single file to paste into the Supabase SQL editor instead.
 *
 * Generated rather than hand-maintained, so it cannot drift from the migrations
 * it is built from.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const OUTPUT = join(__dirname, '..', 'supabase', 'setup-all.sql');

const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();

const parts = [
  '-- ===========================================================================',
  '-- AHN Financial OS - complete schema, generated file. Do not edit by hand.',
  '--',
  '-- Regenerate with:  node scripts/bundle-sql.mjs',
  '-- Source:           supabase/migrations/*.sql',
  '--',
  '-- Paste the whole file into the Supabase SQL editor and run it. Every',
  '-- statement is idempotent, so running it twice is safe.',
  '-- ===========================================================================',
  '',
];

for (const file of files) {
  const sql = await readFile(join(MIGRATIONS, file), 'utf8');
  parts.push(
    '',
    `-- ${'='.repeat(74)}`,
    `-- ${file}`,
    `-- ${'='.repeat(74)}`,
    '',
    sql.trimEnd(),
    '',
  );
}

await writeFile(OUTPUT, `${parts.join('\n')}\n`, 'utf8');
console.log(`Wrote supabase/setup-all.sql from ${files.length} migrations.`);
