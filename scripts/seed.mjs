#!/usr/bin/env node
/**
 * Load demo data into an existing schema.
 *
 *   npm run db:seed
 *
 * Needs only NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY - the same
 * two values the app itself runs on. Deliberately does NOT require
 * SUPABASE_DB_URL: seeding is pure INSERT/UPDATE, and Supabase's direct
 * Postgres host is IPv6-only on many projects, so requiring it would block
 * seeding on plenty of otherwise working setups.
 *
 * Run the migrations first (`npm run db:push`, or paste
 * supabase/setup-all.sql into the SQL editor). Re-running is safe.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { seed } from './seed-demo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

await loadEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error(
    '\n  NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local.\n',
  );
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

try {
  // Fail with a useful message rather than a wall of "relation does not exist".
  const { error: probe } = await supabase.from('transactions').select('id').limit(1);
  if (probe) {
    if (probe.code === 'PGRST205' || /Could not find the table/i.test(probe.message)) {
      console.error(
        '\n  The schema has not been created yet.\n' +
          '  Paste supabase/setup-all.sql into the Supabase SQL editor and run it,\n' +
          '  then run `npm run db:seed` again.\n',
      );
      process.exit(1);
    }
    throw new Error(probe.message);
  }

  if (process.argv.includes('--reset')) {
    await removeDemoData(supabase);
  }

  if (process.argv.includes('--reset-only')) {
    console.log('');
    console.log('  Demo data removed. Nothing was seeded.');
    console.log('');
    process.exit(0);
  }

  console.log(`Seeding ${url} …\n`);
  await seed(supabase);
  console.log('\nDone. Reload the dashboard.\n');
} catch (err) {
  console.error(`\n  Failed: ${err.message}\n`);
  process.exitCode = 1;
}

/**
 * Remove everything `seed()` created, and nothing else.
 *
 * Transactions alone are not enough. The seeder also writes demo ACCOUNTS with a
 * `reported_balance_minor` on them, and an account balance is what the cash
 * figure actually reads — so deleting the transactions while leaving the
 * accounts produces phantom cash with nothing behind it, which is worse than
 * leaving the demo data in place.
 *
 * Two things are deliberately NOT deleted:
 *
 *   - **Companies.** `financial_accounts.company_id` cascades on delete, and
 *     "AHN Media LLC" is now the parent of the real QuickBooks accounts.
 *     Removing it would destroy live data.
 *   - **Accounts a connector created.** Only `external_account_id` beginning
 *     `demo-` is touched.
 */
async function removeDemoData(supabase) {
  const { data: demoAccounts } = await supabase
    .from('financial_accounts')
    .select('id,name')
    .like('external_account_id', 'demo-%');

  const { count: txnCount } = await supabase
    .from('transactions')
    .delete({ count: 'exact' })
    .like('external_txn_id', 'demo-%');
  console.log(`  transactions   removed ${txnCount ?? 0}`);

  if (demoAccounts?.length) {
    const ids = demoAccounts.map((a) => a.id);
    // A hand-entered row on a demo account is still demo data.
    const { count: strays } = await supabase
      .from('transactions')
      .delete({ count: 'exact' })
      .in('account_id', ids);
    if (strays) console.log(`  strays         removed ${strays} on demo accounts`);

    const { count: acctCount } = await supabase
      .from('financial_accounts')
      .delete({ count: 'exact' })
      .in('id', ids);
    console.log(`  accounts       removed ${acctCount ?? 0} (with their reported balances)`);
  }

  // Counterparties left pointing at nothing. Vendors a real connector created
  // are still referenced by real rows, so they survive.
  const { data: remaining } = await supabase.from('transactions').select('counterparty_id');
  const stillUsed = new Set((remaining ?? []).map((r) => r.counterparty_id).filter(Boolean));
  const { data: allParties } = await supabase.from('counterparties').select('id');
  const orphans = (allParties ?? []).map((p) => p.id).filter((id) => !stillUsed.has(id));
  if (orphans.length) {
    for (let i = 0; i < orphans.length; i += 200) {
      await supabase.from('counterparties').delete().in('id', orphans.slice(i, i + 200));
    }
    console.log(`  counterparties removed ${orphans.length} left with no transactions`);
  }

  // Alert history for money that no longer exists. Migration 0004 sets
  // transaction_id to null when a transaction goes, so these are the strays.
  const { count: notifCount } = await supabase
    .from('notifications')
    .delete({ count: 'exact' })
    .is('transaction_id', null);
  if (notifCount) console.log(`  notifications  removed ${notifCount} with no transaction`);

  const { count: importCount } = await supabase
    .from('manual_imports')
    .delete({ count: 'exact' })
    .not('id', 'is', null);
  if (importCount) console.log(`  manual_imports removed ${importCount}`);
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
