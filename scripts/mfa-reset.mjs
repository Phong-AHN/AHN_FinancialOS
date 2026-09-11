#!/usr/bin/env node
/**
 * Remove a person's authenticator, so they can set up a new one.
 *
 *   node scripts/mfa-reset.mjs person@example.com            (shows what would go)
 *   node scripts/mfa-reset.mjs person@example.com --confirm  (does it)
 *
 * WHY THIS EXISTS. Two-factor sign-in is mandatory (migration 0040), so a lost
 * or replaced phone locks its owner out completely. This is the way back in:
 * their factors are deleted, and their next sign-in takes them to set up a new
 * authenticator.
 *
 * IT IS THE MOST SENSITIVE THING IN THIS REPOSITORY. Resetting somebody's
 * second factor reduces their account to its password — which is exactly what
 * an attacker who has phished that password would ask support to do. So:
 *
 *   - It runs only locally, with the service-role key, never from the app.
 *     There is deliberately no button for this.
 *   - It does nothing without --confirm, and says what it would do first.
 *   - It writes an audit record.
 *
 * It does NOT end sessions already open. Supabase's admin sign-out takes the
 * user's own token, not their id, so there is no call here that could — and a
 * line that looked like one, with its error swallowed, would have claimed a
 * protection that did not exist. The person resetting has, by definition, no
 * working session; if an account is suspected COMPROMISED rather than locked
 * out, change its password in the Supabase dashboard as well, which does end
 * them.
 *
 * CONFIRM WHO IS ASKING before running it — a call to a number already on
 * file, or in person. Never on the strength of an email that says "I lost my
 * phone": that email is the attack.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const [, , email, flag] = process.argv;
if (!email) {
  console.error('\n  Usage: node scripts/mfa-reset.mjs <email> [--confirm]\n');
  process.exit(1);
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('\n  SUPABASE_SERVICE_ROLE_KEY is not set in .env.local.\n');
  process.exit(1);
}

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: appUser } = await admin
  .from('users')
  .select('id,auth_id,email,role,full_name')
  .ilike('email', email)
  .maybeSingle();
if (!appUser?.auth_id) {
  console.error(`\n  No signed-up account for ${email}.\n`);
  process.exit(1);
}

const { data: listed, error: listError } = await admin.auth.admin.mfa.listFactors({ userId: appUser.auth_id });
if (listError) {
  console.error(`\n  Could not list factors: ${listError.message}\n`);
  process.exit(1);
}
const factors = listed?.factors ?? [];

console.log(`\n  ${appUser.full_name ?? appUser.email} <${appUser.email}> — role ${appUser.role}`);
console.log(`  ${factors.length} authenticator(s):`);
for (const f of factors) console.log(`    · ${f.friendly_name ?? f.factor_type} (${f.status}, added ${f.created_at?.slice(0, 10)})`);

if (factors.length === 0) {
  console.log('\n  Nothing to reset — their next sign-in already asks them to set one up.\n');
  process.exit(0);
}
if (flag !== '--confirm') {
  console.log('\n  Nothing changed. Re-run with --confirm once you have confirmed who is asking.\n');
  process.exit(0);
}

for (const f of factors) {
  const { error } = await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId: appUser.auth_id });
  if (error) {
    console.error(`  Could not delete ${f.id}: ${error.message}`);
    process.exit(1);
  }
}

const { error: auditError } = await admin.from('audit_logs').insert({
  table_name: 'users',
  record_id: appUser.id,
  field: 'mfa_factors',
  old_value: `${factors.length} authenticator(s)`,
  new_value: 'none',
  reason: 'Two-factor reset by an administrator (scripts/mfa-reset.mjs) — identity confirmed out of band',
  user_email: 'scripts/mfa-reset.mjs',
});

// Reported, not swallowed. The reset has happened either way; a missing audit
// record is something the operator must know about and write down by hand.
if (auditError) console.error(`  WARNING: the reset is done but the audit record failed: ${auditError.message}`);

console.log(`\n  Removed ${factors.length} authenticator(s). Their next sign-in will ask them to set up a new one.\n`);
