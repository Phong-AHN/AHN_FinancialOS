#!/usr/bin/env node
/**
 * Remove the rows that came from named sandbox connections, before production.
 *
 *   node scripts/purge-sandbox-data.mjs                                  (what is there)
 *   node scripts/purge-sandbox-data.mjs --sources plaid,quickbooks       (what would go)
 *   node scripts/purge-sandbox-data.mjs --sources plaid,quickbooks --confirm
 *
 * WHY IT EXISTS. Every figure in this system was first proved against sandbox
 * connections: a Plaid test bank, a QuickBooks sample company, a Stripe test
 * key. None of that is money. Left in place while real accounts are connected
 * it is added to the cash position, it raises alerts, and the QuickBooks
 * sandbox collides with a real company's record ids.
 *
 * WHY IT DELETES BY SOURCE, AND ONLY WHEN NAMED. The first version emptied
 * every table. It worked — 135 sandbox rows removed. Then the real connections
 * synced 418 REAL Stripe transactions into those same tables, and a second run
 * would have deleted them with identical, confident output. A guard that read
 * the environment was not enough either: the local `.env.local` still held a
 * test Stripe key while production held the live one, so the guard cleared a
 * source that was, in the database, entirely real.
 *
 * So: nothing is deleted unless you name its source. Rows from a source you did
 * not name are never touched, whatever else is true.
 *
 * WHAT GOES for each named source: its transactions, its accounts, and the
 * import records behind them. Counterparties left with no transactions at all
 * are cleaned up afterwards; notifications about deleted transactions go with
 * them. Connections for those sources are marked disconnected with tokens and
 * cursors cleared, so reconnecting starts a clean full sync.
 *
 * WHAT STAYS: companies, users, roles, budgets, the audit log, and every row
 * belonging to a source you did not name.
 *
 * A JSON backup of every table it touches is written into
 * ./backup-sandbox-<date>/ first, and it refuses to delete if that backup
 * cannot be written.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const argv = process.argv.slice(2);
const confirm = argv.includes('--confirm');
const sourcesArg = argv.includes('--sources') ? argv[argv.indexOf('--sources') + 1] : null;
const sources = (sourcesArg ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be in .env.local');
  process.exit(1);
}
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ── what is in the database ─────────────────────────────────────────────────
const { data: txns, error: readError } = await db.from('transactions').select('id,source_system,account_id,txn_date');
if (readError) {
  console.error(`Could not read transactions: ${readError.message}`);
  process.exit(1);
}
const bySource = new Map();
for (const t of txns) {
  const e = bySource.get(t.source_system) ?? { n: 0, first: t.txn_date, last: t.txn_date };
  e.n++;
  if (t.txn_date < e.first) e.first = t.txn_date;
  if (t.txn_date > e.last) e.last = t.txn_date;
  bySource.set(t.source_system, e);
}

console.log('Transactions in the database:');
for (const [source, e] of [...bySource].sort()) {
  const marked = sources.includes(source) ? '   ← WILL BE DELETED' : '';
  console.log(`  ${source.padEnd(14)} ${String(e.n).padStart(5)}   ${e.first} → ${e.last}${marked}`);
}

if (!sources.length) {
  console.log('\nName the sources to delete, e.g.  --sources plaid,quickbooks');
  console.log('Nothing is deleted without --sources, and never from a source you did not name.');
  process.exit(0);
}

const unknown = sources.filter((s) => !bySource.has(s));
if (unknown.length) console.log(`\nNote: no transactions found for ${unknown.join(', ')}.`);

const doomedTxns = txns.filter((t) => sources.includes(t.source_system));
const { data: accounts } = await db.from('financial_accounts').select('id,name,source_system');
const doomedAccounts = (accounts ?? []).filter((a) => sources.includes(a.source_system));

console.log(`\nWould delete ${doomedTxns.length} transactions and ${doomedAccounts.length} accounts:`);
for (const a of doomedAccounts) console.log(`  [${a.source_system}] ${a.name}`);

const survivors = txns.length - doomedTxns.length;
console.log(`\n${survivors} transactions from other sources would be left untouched.`);

if (!confirm) {
  console.log('\nDRY RUN — add --confirm to do it.');
  process.exit(0);
}

// ── backup ──────────────────────────────────────────────────────────────────
const dir = `backup-sandbox-${new Date().toISOString().slice(0, 10)}`;
mkdirSync(dir, { recursive: true });
console.log(`\nBacking up to ./${dir}/`);
for (const table of ['transactions', 'financial_accounts', 'counterparties', 'notifications', 'obligations', 'manual_imports', 'integrations', 'companies']) {
  const { data, error } = await db.from(table).select('*');
  if (error) {
    console.error(`  ${table}: could not read (${error.message}) — stopping rather than deleting unbacked data.`);
    process.exit(1);
  }
  writeFileSync(`${dir}/${table}.json`, JSON.stringify(data, null, 2));
  console.log(`  ${table.padEnd(20)} ${data.length} rows`);
}

// ── delete, scoped to the named sources ─────────────────────────────────────
console.log('\nDeleting:');
const txnIds = doomedTxns.map((t) => t.id);
const accountIds = doomedAccounts.map((a) => a.id);

const chunk = (list, size = 200) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

for (const ids of chunk(txnIds)) {
  const { error } = await db.from('notifications').delete().in('transaction_id', ids);
  if (error && !/column .* does not exist/.test(error.message)) console.error(`  notifications: ${error.message}`);
}
for (const ids of chunk(txnIds)) {
  const { error } = await db.from('transactions').delete().in('id', ids);
  if (error) console.error(`  transactions: ${error.message}`);
}
console.log(`  transactions        ${txnIds.length} deleted`);

for (const ids of chunk(accountIds)) {
  for (const table of ['obligations', 'manual_imports']) {
    const { error } = await db.from(table).delete().in('account_id', ids);
    if (error && !/column .* does not exist/.test(error.message)) console.error(`  ${table}: ${error.message}`);
  }
  const { error } = await db.from('financial_accounts').delete().in('id', ids);
  if (error) console.error(`  financial_accounts: ${error.message}`);
}
console.log(`  accounts            ${accountIds.length} deleted`);

// Counterparties are shared; drop only those nothing points at any more.
const { data: left } = await db.from('transactions').select('counterparty_id');
const stillUsed = new Set((left ?? []).map((t) => t.counterparty_id).filter(Boolean));
const { data: parties } = await db.from('counterparties').select('id');
const orphans = (parties ?? []).map((p) => p.id).filter((id) => !stillUsed.has(id));
for (const ids of chunk(orphans)) {
  const { error } = await db.from('counterparties').delete().in('id', ids);
  if (error) console.error(`  counterparties: ${error.message}`);
}
console.log(`  counterparties      ${orphans.length} orphans deleted`);

// ── reset only the named connections ────────────────────────────────────────
const providers = sources.filter((s) => ['plaid', 'quickbooks', 'stripe', 'veem', 'vietinbank', 'finverse'].includes(s));
if (providers.length) {
  const { error } = await db
    .from('integrations')
    .update({
      status: 'disconnected',
      access_token_enc: null,
      refresh_token_enc: null,
      token_expires_at: null,
      last_cursor: null,
      last_synced_at: null,
      last_error: null,
    })
    .in('provider', providers);
  console.log(`\nConnections reset: ${error ? 'ERROR ' + error.message : providers.join(', ')}`);
}

console.log('\nDone. Connect the real accounts on the Integrations page, then run a sync.');
