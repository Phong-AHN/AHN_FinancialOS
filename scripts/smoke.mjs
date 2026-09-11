#!/usr/bin/env node
/**
 * Authenticated page smoke test.
 *
 *   npm run smoke -- --ephemeral [base-url]
 *   npm run smoke -- you@example.com 'your-password' --totp <base32-secret> [base-url]
 *
 * Every account needs two factors (migration 0040), so a password alone now
 * reads an empty application. Two ways in:
 *
 *   --ephemeral  creates a throwaway OWNER, gives it an authenticator whose
 *                secret only this process knows, runs, and deletes it. Nobody's
 *                real account is signed in to. Needs the service-role key from
 *                .env.local. This is the one to use.
 *   --totp       your own account and your own authenticator secret, for
 *                checking a deployment as yourself.
 *
 * Builds the session cookie that @supabase/ssr expects and fetches every page.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE TEST SUITE
 *
 * The unit and integration tests prove the numbers are right. They call the
 * calc engine directly, so a page that throws while rendering those numbers -
 * a bad prop, a null the component does not guard, a server/client boundary
 * mistake - passes every one of them. `next build` does not catch it either,
 * because every page here is server-rendered on demand.
 *
 * Nothing else in this repo loads a page as a logged-in user. This does.
 *
 * The password is read from argv and never written to any file.
 */
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2];
}

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const ref = new URL(url).hostname.split('.')[0];

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const ephemeral = args.includes('--ephemeral');
if (ephemeral) args.splice(args.indexOf('--ephemeral'), 1);
const totpSecret = flag('--totp');
const [email, password, baseArg] = ephemeral ? [null, null, args[0]] : args;
const base = (baseArg ?? 'http://localhost:3000').replace(/\/$/, '');

if (!ephemeral && (!email || !password || !totpSecret)) {
  console.error(
    [
      '',
      '  Usage: npm run smoke -- --ephemeral [base-url]',
      "     or: npm run smoke -- <email> <password> --totp <base32-secret> [base-url]",
      '',
      '  Every account needs two factors now, so a password alone is not enough.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

/** RFC 6238 — the code an authenticator app would show. */
function totp(secret, at = Date.now()) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').replace(/\s/g, '').toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = crypto.createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const admin = ephemeral
  ? createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;
let tempAuthId = null;
let tempAppUserId = null;

/** Removes the throwaway owner. Called on every way out of this script. */
async function cleanup() {
  if (!admin) return;
  if (tempAppUserId) await admin.from('users').delete().eq('id', tempAppUserId);
  if (tempAuthId) await admin.auth.admin.deleteUser(tempAuthId);
  tempAuthId = tempAppUserId = null;
}
const exit = async (code) => {
  await cleanup();
  process.exit(code);
};

let session;
try {
  const client = createClient(url, anon, { auth: { persistSession: false } });
  let signInEmail = email;
  let signInPassword = password;

  if (ephemeral) {
    signInEmail = `smoke-${Date.now()}@probe.invalid`;
    signInPassword = crypto.randomBytes(18).toString('base64url');
    const { data, error } = await admin.auth.admin.createUser({
      email: signInEmail,
      password: signInPassword,
      email_confirm: true,
    });
    if (error) throw error;
    tempAuthId = data.user.id;
    const { data: row, error: rowError } = await admin
      .from('users')
      .insert({ email: signInEmail, role: 'owner', auth_id: tempAuthId, full_name: 'SMOKE (temporary)' })
      .select('id')
      .single();
    if (rowError) throw rowError;
    tempAppUserId = row.id;
  }

  const { error: signError } = await client.auth.signInWithPassword({ email: signInEmail, password: signInPassword });
  if (signError) throw signError;

  let factorId;
  let secret = totpSecret;
  if (ephemeral) {
    const { data: factor, error } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'smoke' });
    if (error) throw error;
    factorId = factor.id;
    secret = factor.totp.secret;
  } else {
    const { data } = await client.auth.mfa.listFactors();
    factorId = data?.totp?.[0]?.id;
    if (!factorId) throw new Error('this account has no verified authenticator — set one up in the app first');
  }
  const { error: verifyError } = await client.auth.mfa.challengeAndVerify({ factorId, code: totp(secret) });
  if (verifyError) throw verifyError;

  session = (await client.auth.getSession()).data.session;
} catch (err) {
  console.error('sign-in failed:', err.message ?? err);
  await exit(1);
}
console.log(`signed in with two factors as ${session.user.email}${ephemeral ? ' (temporary owner)' : ''}\n`);

// @supabase/ssr stores the session as base64-encoded JSON, chunked at 3180 chars.
const payload = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64');
const name = `sb-${ref}-auth-token`;
const CHUNK = 3180;
const cookies = [];
if (payload.length <= CHUNK) {
  cookies.push(`${name}=${payload}`);
} else {
  for (let i = 0; i * CHUNK < payload.length; i++) {
    cookies.push(`${name}.${i}=${payload.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  }
}
const cookieHeader = cookies.join('; ');

const pages = [
  ['/', ['Cash on hand', 'Break-even', 'Runway', 'needs attention', 'Where the cash is']],
  // "By country" and "By entity" render only with more than one of each, so
  // they are not required - a single-entity company is a normal state.
  ['/accounts', ['Total cash', 'Provider says', 'Our records']],
  ['/transactions', ['Transactions', 'Counterparty']],
  ['/reconcile', ['Reconcile', 'Possible duplicates', 'Re-run categorisation']],
  // State-independent: an empty portfolio renders the empty state, not the
  // table, so checking for "Every project" would fail whenever there are none.
  ['/projects', ['What each piece of work brought in']],
  ['/explain', ['Where the cash went']],
  ['/obligations', ['Money that is going to move']],
  ['/budgets', ['What was planned, what has been spent']],
  ['/simulator', ['What a growth rate implies']],
  ['/people', ['People', 'Costing basis', 'Log hours']],
  ['/subscriptions', ['Recurring charges', 'Monthly recurring', 'Every recurring charge']],
  ['/alerts', ['Rules', 'End-to-end test', 'Delivery log']],
  ['/integrations', ['QuickBooks', 'Plaid', 'Stripe', 'Recent provider errors']],
  ['/import', ['Import a statement']],
  ['/payroll', ['Payroll']],
  ['/timesheet', ['My hours']],
  ['/access', ['Who has access']],
  ['/audit', ['Audit log']],
];

/**
 * The pages Intuit and Plaid open WHILE SIGNED OUT.
 *
 * Checked without the session cookie on purpose. Every one of these is pasted
 * into a provider's app settings, and a reviewer who gets bounced to /login
 * files that as a finding — which is invisible from a smoke run that is
 * authenticated for everything.
 */
const publicPages = [
  ['/privacy', ['Privacy Policy', 'QuickBooks Online (Intuit)', 'Plaid']],
  ['/eula', ['End-User License Agreement', 'Governing law', 'not produced, endorsed']],
  ['/disconnect', ['QuickBooks has been disconnected']],
  ['/support', ['Support', 'intuit_tid', 'team@asianhustlenetwork.com']],
];

let failures = 0;
for (const [path, expects] of pages) {
  let r;
  try {
    r = await fetch(`${base}${path}`, {
      headers: { cookie: cookieHeader },
      redirect: 'manual',
    });
  } catch (err) {
    // A dead server should say so, not print a stack trace at someone trying to
    // find out whether their pages render.
    failures++;
    const reason = err.cause?.code === 'ECONNREFUSED' ? 'connection refused' : err.message;
    console.log(`FAIL  ${path.padEnd(16)} ${reason}`);
    if (reason === 'connection refused') {
      console.error(`  Nothing is listening on ${base}. Start it with "npm run start".`);
      await exit(1);
    }
    continue;
  }
  const body = r.status === 200 ? await r.text() : '';
  const missing = expects.filter((e) => !body.toLowerCase().includes(e.toLowerCase()));
  const errored = /Application error|Internal Server Error|Unhandled Runtime/i.test(body);

  const ok = r.status === 200 && missing.length === 0 && !errored;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${path.padEnd(16)} ${r.status}` +
      (r.status === 307 || r.status === 302 ? ` -> ${r.headers.get('location')}` : '') +
      (errored ? '  [render error]' : '') +
      (missing.length ? `  missing: ${missing.join(', ')}` : ''),
  );
}

for (const [path, expects] of publicPages) {
  let r;
  try {
    r = await fetch(`${base}${path}`, { redirect: 'manual' });
  } catch (err) {
    failures++;
    console.log(`FAIL  ${path.padEnd(16)} ${err.message}`);
    continue;
  }
  const body = r.status === 200 ? await r.text() : '';
  const missing = expects.filter((e) => !body.toLowerCase().includes(e.toLowerCase()));
  const ok = r.status === 200 && missing.length === 0;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${path.padEnd(16)} ${r.status} (anonymous)` +
      (r.status === 307 || r.status === 302 ? ` -> ${r.headers.get('location')}` : '') +
      (missing.length ? `  missing: ${missing.join(', ')}` : ''),
  );
}

// The Launch URL is a redirect, not a page: signed out it must reach sign-in,
// carrying where it was going.
{
  const r = await fetch(`${base}/launch`, { redirect: 'manual' });
  const location = r.headers.get('location') ?? '';
  const ok = (r.status === 307 || r.status === 302) && location.includes('/login');
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${'/launch'.padEnd(16)} ${r.status} (anonymous) -> ${location}`);
}

// Pull the runway figures straight out of the rendered HTML.
const html = failures === 0
  ? await (await fetch(`${base}/`, { headers: { cookie: cookieHeader } })).text()
  : '';
const grab = (label) => {
  const i = html.indexOf(label);
  if (i === -1) return '(not found)';
  const after = html.slice(i, i + 400).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  return after.slice(0, 120);
};
console.log('\nRendered runway block:');
for (const l of ['If revenue stopped', 'At current net burn', 'Worst month on record']) {
  console.log('  ' + grab(l));
}

console.log('');
if (failures) {
  console.error(`  ${failures} page(s) failed to render.`);
} else {
  console.log('  Every page rendered for a signed-in owner.');
}
console.log('');
await exit(failures ? 1 : 0);
