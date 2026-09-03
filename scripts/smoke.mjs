#!/usr/bin/env node
/**
 * Authenticated page smoke test.
 *
 *   npm run smoke -- you@example.com 'your-password'
 *   npm run smoke -- you@example.com 'your-password' https://your-app.vercel.app
 *
 * Signs in through Supabase's password grant, builds the session cookie that
 * @supabase/ssr expects, and fetches every page as a signed-in owner.
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

const [, , email, password, baseArg] = process.argv;
const base = (baseArg ?? 'http://localhost:3000').replace(/\/$/, '');

if (!email || !password) {
  console.error(
    ['', '  Usage: npm run smoke -- <email> <password> [base-url]', ''].join('\n'),
  );
  process.exit(1);
}

const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: anon, 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const session = await res.json();
if (!res.ok || !session.access_token) {
  console.error('sign-in failed:', JSON.stringify(session).slice(0, 200));
  process.exit(1);
}
console.log(`signed in as ${session.user.email}\n`);

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
  ['/integrations', ['QuickBooks', 'Plaid', 'Stripe']],
  ['/import', ['Import a statement']],
  ['/timesheet', ['My hours']],
  ['/access', ['Who has access']],
  ['/audit', ['Audit log']],
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
      process.exit(1);
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
process.exit(failures ? 1 : 0);
