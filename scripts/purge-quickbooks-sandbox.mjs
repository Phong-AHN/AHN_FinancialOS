#!/usr/bin/env node
/**
 * Remove a QuickBooks SANDBOX company's data before a real company is connected.
 *
 *   node scripts/purge-quickbooks-sandbox.mjs --realm <realmId>            (shows what would go)
 *   node scripts/purge-quickbooks-sandbox.mjs --realm <realmId> --confirm  (does it)
 *
 * WHY THIS IS NOT OPTIONAL. QuickBooks numbers every company's records from 1.
 * This system keys a QuickBooks transaction as `Purchase:123` and an account by
 * its QuickBooks account id — neither says WHICH company. So a real company's
 * `Purchase:123` is the same key as the sandbox company's `Purchase:123`, and:
 *
 *   - the real purchase is SKIPPED as a duplicate of the fake one
 *     (ingest never overwrites a row it already holds), and
 *   - the real bank account is MERGED into the sandbox account with that id.
 *
 * Nothing errors. The dashboard simply shows fake money with real money missing
 * from under it. Clearing the sandbox company first is the only way the real
 * one arrives whole. The OAuth callback refuses to connect a second company
 * while another is still on record, so this cannot be skipped by accident.
 *
 * GUARDS, in the order they are checked:
 *   1. You name the realm. The script deletes nothing you did not name.
 *   2. Exactly one QuickBooks company may be on record, and it must be the one
 *      you named. Two would mean a real company is already connected, and its
 *      rows are indistinguishable from the sandbox's — this would delete them.
 *   3. The connection must already be DISCONNECTED (Integrations → Disconnect),
 *      so its grant was revoked at Intuit rather than orphaned there.
 *   4. Nothing changes without --confirm.
 *
 * What it removes: every QuickBooks transaction, obligation and account, the
 * sandbox integration row and its error log, and counterparties nothing refers
 * to any more. What it keeps: the audit trail, the notification log, and every
 * row from any other source.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const args = process.argv.slice(2);
const realm = args[args.indexOf('--realm') + 1];
const confirm = args.includes('--confirm');
const stop = (msg) => {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
};

if (!args.includes('--realm') || !realm || realm.startsWith('--')) {
  stop('Usage: node scripts/purge-quickbooks-sandbox.mjs --realm <realmId> [--confirm]');
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) stop('SUPABASE_SERVICE_ROLE_KEY is not set in .env.local.');

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const count = async (table, build) => {
  const { count: n, error } = await build(db.from(table).select('id', { count: 'exact', head: true }));
  if (error) stop(`Could not count ${table}: ${error.message}`);
  return n ?? 0;
};

// ── guards ───────────────────────────────────────────────────────────────────
const { data: companies, error: listError } = await db
  .from('integrations')
  .select('id,external_id,label,status,refresh_token_enc,created_at')
  .eq('provider', 'quickbooks');
if (listError) stop(`Could not read integrations: ${listError.message}`);

if ((companies ?? []).length === 0) stop('No QuickBooks company is on record. Nothing to purge.');
if (companies.length > 1) {
  stop(
    `${companies.length} QuickBooks companies are on record (${companies.map((c) => c.external_id).join(', ')}).\n` +
      '  Their rows cannot be told apart, so purging now would delete real data too. Stop and ask.',
  );
}
const company = companies[0];
if (company.external_id !== realm) {
  stop(`The QuickBooks company on record is ${company.external_id} ("${company.label}"), not ${realm}.`);
}
if (company.refresh_token_enc) {
  stop(
    `"${company.label}" is still connected.\n` +
      '  Disconnect it on the Integrations page first, so its grant is revoked at Intuit\n' +
      '  instead of being left live there with nobody holding the token.',
  );
}

// ── what would go ────────────────────────────────────────────────────────────
const qbo = (q) => q.eq('source_system', 'quickbooks');
const plan = {
  transactions: await count('transactions', qbo),
  obligations: await count('obligations', qbo),
  accounts: await count('financial_accounts', qbo),
  errors: await count('integration_errors', (q) => q.eq('integration_id', company.id)),
};

// Rows from OTHER sources that point at a QuickBooks row as their duplicate —
// they would lose the pointer and stay hidden from cash. Returned to review.
const { data: qboIds } = await db.from('transactions').select('id').eq('source_system', 'quickbooks');
const ids = (qboIds ?? []).map((r) => r.id);
const { data: linked } = ids.length
  ? await db.from('transactions').select('id').neq('source_system', 'quickbooks').in('duplicate_of_id', ids)
  : { data: [] };

console.log(`\n  QuickBooks company ${company.external_id} — "${company.label}" (${company.status})`);
console.log(`    transactions         ${plan.transactions}`);
console.log(`    obligations          ${plan.obligations}`);
console.log(`    accounts             ${plan.accounts}`);
console.log(`    error-log rows       ${plan.errors}`);
console.log(`    other-source rows marked as its duplicates, to be returned to review: ${linked?.length ?? 0}`);
console.log('    + the integration row, and any counterparty nothing refers to afterwards');

if (!confirm) {
  console.log('\n  Nothing changed. Re-run with --confirm to remove the above.\n');
  process.exit(0);
}

// ── do it ────────────────────────────────────────────────────────────────────
const must = async (label, promise) => {
  const { error } = await promise;
  if (error) stop(`${label} failed: ${error.message} — stopped; nothing after this step ran.`);
};

if (linked?.length) {
  await must(
    'returning linked duplicates to review',
    db
      .from('transactions')
      .update({ duplicate_of_id: null, reconciliation_status: 'unreconciled' })
      .in('id', linked.map((r) => r.id)),
  );
}
await must('deleting transactions', db.from('transactions').delete().eq('source_system', 'quickbooks'));
await must('deleting obligations', db.from('obligations').delete().eq('source_system', 'quickbooks'));
await must('deleting accounts', db.from('financial_accounts').delete().eq('source_system', 'quickbooks'));
await must('deleting error log', db.from('integration_errors').delete().eq('integration_id', company.id));
await must('deleting the integration', db.from('integrations').delete().eq('id', company.id));

// Counterparties nothing refers to any more.
const { data: parties } = await db.from('counterparties').select('id');
let orphans = 0;
for (const { id } of parties ?? []) {
  const used =
    (await count('transactions', (q) => q.eq('counterparty_id', id))) +
    (await count('obligations', (q) => q.eq('counterparty_id', id))) +
    (await count('clients', (q) => q.eq('counterparty_id', id)));
  if (used === 0) {
    await must('deleting an orphan counterparty', db.from('counterparties').delete().eq('id', id));
    orphans++;
  }
}

const { error: auditError } = await db.from('audit_logs').insert({
  table_name: 'integrations',
  record_id: company.id,
  field: 'purged',
  old_value: `QuickBooks sandbox ${company.external_id}: ${plan.transactions} transactions, ${plan.obligations} obligations, ${plan.accounts} accounts`,
  new_value: 'removed',
  reason: 'Sandbox company cleared before connecting the production company (scripts/purge-quickbooks-sandbox.mjs)',
  user_email: 'scripts/purge-quickbooks-sandbox.mjs',
});
if (auditError) console.error(`  WARNING: the purge is done but the audit record failed: ${auditError.message}`);

const after = {
  transactions: await count('transactions', qbo),
  obligations: await count('obligations', qbo),
  accounts: await count('financial_accounts', qbo),
};
console.log(
  `\n  Removed. QuickBooks rows left: ${after.transactions} transactions, ${after.obligations} obligations, ` +
    `${after.accounts} accounts. ${orphans} orphan counterparties removed.`,
);
console.log('  You can now connect the production company from the Integrations page.\n');
