#!/usr/bin/env node
/**
 * Create a sign-in account.
 *
 *   node scripts/create-user.mjs <email> <password> [owner|viewer]
 *
 * Does both halves of the job, which is the part that trips people up:
 *   1. the Supabase Auth user  (auth.users - what you sign in with)
 *   2. the application row     (public.users - what carries the role)
 *
 * With only the first, sign-in succeeds and then bounces straight back to the
 * login screen, because `getSession()` finds no application user and treats the
 * session as unprovisioned.
 *
 * `email_confirm: true` marks the address verified on creation, so the account
 * works immediately without waiting on a confirmation email - the right call for
 * an internal tool where an admin is creating the account deliberately.
 *
 * Re-running for an existing address updates that account's password and role
 * rather than failing.
 *
 * The password is read from argv and never written to any file in this repo.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const [, , emailArg, passwordArg, roleArg = 'owner'] = process.argv;

if (!emailArg || !passwordArg) {
  console.error('\n  Usage: node scripts/create-user.mjs <email> <password> [owner|viewer]\n');
  process.exit(1);
}
if (roleArg !== 'owner' && roleArg !== 'viewer') {
  console.error(`\n  Role must be "owner" or "viewer", got "${roleArg}".\n`);
  process.exit(1);
}
if (passwordArg.length < 8) {
  console.error('\n  Supabase requires a password of at least 8 characters.\n');
  process.exit(1);
}

await loadEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error(
    '\n  NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local.\n',
  );
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const email = emailArg.trim().toLowerCase();

try {
  // ── 1. The auth account ───────────────────────────────────────────────────
  let authUser = await findAuthUser(email);

  if (authUser) {
    const { data, error } = await admin.auth.admin.updateUserById(authUser.id, {
      password: passwordArg,
      email_confirm: true,
    });
    if (error) throw new Error(`Could not update the existing auth user: ${error.message}`);
    authUser = data.user;
    console.log(`  auth.users   updated  ${email}`);
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: passwordArg,
      email_confirm: true,
    });
    if (error) throw new Error(`Could not create the auth user: ${error.message}`);
    authUser = data.user;
    console.log(`  auth.users   created  ${email}`);
  }

  // ── 2. The application row that carries the role ──────────────────────────
  const { data: existing, error: readError } = await admin
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (readError) {
    if (readError.code === 'PGRST205' || /Could not find the table/i.test(readError.message)) {
      console.error(
        '\n  The `users` table does not exist yet — the migrations have not been run.\n' +
          '  Apply supabase/setup-all.sql in the Supabase SQL editor (or set SUPABASE_DB_URL\n' +
          '  and run `npm run db:push`), then run this script again.\n\n' +
          `  The auth account for ${email} was created, so only step 2 is outstanding.\n`,
      );
      process.exit(1);
    }
    throw new Error(`Could not read the users table: ${readError.message}`);
  }

  if (existing) {
    const { error } = await admin
      .from('users')
      .update({ auth_id: authUser.id, role: roleArg })
      .eq('id', existing.id);
    if (error) throw new Error(`Could not update the application user: ${error.message}`);
    console.log(`  public.users updated  role=${roleArg}`);
  } else {
    const { error } = await admin
      .from('users')
      .insert({ email, auth_id: authUser.id, role: roleArg, full_name: nameFromEmail(email) });
    if (error) throw new Error(`Could not create the application user: ${error.message}`);
    console.log(`  public.users created  role=${roleArg}`);
  }

  console.log(`\n  Done. Sign in at /login with ${email} and the password you passed.\n`);
} catch (err) {
  console.error(`\n  Failed: ${err.message}\n`);
  process.exitCode = 1;
}

/** listUsers is paginated; walk it rather than assuming the account is on page 1. */
async function findAuthUser(targetEmail) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`Could not list auth users: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === targetEmail);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

function nameFromEmail(value) {
  const local = value.split('@')[0].replace(/[._-]+/g, ' ');
  return local.replace(/\b\w/g, (c) => c.toUpperCase());
}

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
      // optional
    }
  }
}
