import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The hand-written types, checked against the database that actually exists.
 *
 * `types.ts` opens by saying it is hand-written "rather than generated so the
 * money invariants are documented where they are used". That is a good reason
 * and it has a cost nobody was paying: **drift**. `ObligationRow` went two
 * migrations without `source_system`, `external_id`, `recurrence`,
 * `recurs_until` or `generated_from_id`, and the gap only surfaced when the
 * alert engine needed one of them (decision 98).
 *
 * The two directions fail differently, so they are reported separately:
 *
 *   - **A column the database has and TypeScript does not** is a column no code
 *     can use. It fails silently, as a feature nobody can build, and it is how
 *     a QuickBooks sandbox invoice ended up indistinguishable from a real one.
 *   - **A field TypeScript claims and the database does not have** is a runtime
 *     failure waiting for the first query that selects it — the shape of bug
 *     that told AHN "0 alert rules exist" (decision 96).
 *
 * This reads the real source file rather than restating its fields, so the test
 * cannot drift from the thing it is checking.
 *
 *   SCHEMA_TEST=1 npx vitest run tests/schema-drift.integration.test.ts
 */
const ENABLED =
  process.env.SCHEMA_TEST === '1' &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

/** Interface in `types.ts` → the table it mirrors. */
const MIRRORS: Record<string, string> = {
  Company: 'companies',
  FinancialAccount: 'financial_accounts',
  Integration: 'integrations',
  Counterparty: 'counterparties',
  Transaction: 'transactions',
  AlertRule: 'alert_rules',
  NotificationRow: 'notifications',
  AppUser: 'users',
  AuditLog: 'audit_logs',
  ManualImport: 'manual_imports',
  ExchangeRate: 'exchange_rates',
  ObligationRow: 'obligations',
};

/**
 * Fields that are deliberately absent from the type.
 *
 * Every entry needs a reason. "We did not get round to it" is drift, which is
 * what this file exists to catch.
 */
const DELIBERATELY_UNTYPED: Record<string, string[]> = {};

/**
 * Tables with no hand-written type in `types.ts`, and that is on purpose.
 *
 * The calc layer defines its own minimal shapes for these — `Person` takes what
 * the labour arithmetic needs, `BudgetRow` what the variance arithmetic needs.
 * Those are deliberately partial, so comparing them against every column would
 * report drift where there is only focus. They are listed here so that "no type
 * exists" stays a decision somebody made rather than something nobody noticed.
 */
const TYPED_IN_THE_CALC_LAYER = [
  'budgets',
  'business_units',
  'clients',
  'people',
  'projects',
  'time_entries',
  // A view, not a table: names for the timesheet picker, no money (migration 0029).
  'projects_for_time',
];

function interfaceFields(source: string, name: string): string[] | null {
  const start = source.indexOf(`export interface ${name} {`);
  if (start === -1) return null;
  const end = source.indexOf('\n}', start);
  const body = source.slice(start, end);

  const fields: string[] = [];
  for (const line of body.split('\n').slice(1)) {
    // `  field?: Type;` — ignores comments, blank lines and nested object lines.
    const m = line.match(/^\s{2}([a-z_][a-z0-9_]*)\??:/i);
    if (m) fields.push(m[1]!);
  }
  return fields;
}

describe.skipIf(!ENABLED)('the types match the database', () => {
  let columns: Record<string, string[]> = {};
  let source = '';

  beforeAll(async () => {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
        authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        accept: 'application/openapi+json',
      },
    });
    const spec = (await res.json()) as {
      definitions?: Record<string, { properties?: Record<string, unknown> }>;
    };
    for (const [table, def] of Object.entries(spec.definitions ?? {})) {
      columns[table] = Object.keys(def.properties ?? {});
    }
    source = fs.readFileSync(path.join(process.cwd(), 'src/lib/types.ts'), 'utf8');
  }, 60_000);

  it('describes every table the types claim to mirror', () => {
    const missing = Object.values(MIRRORS).filter((t) => !columns[t]);
    expect(missing, 'tables named in MIRRORS that the database does not have').toEqual([]);
  });

  it('has no column the database holds and TypeScript cannot see', () => {
    const drift: string[] = [];
    for (const [iface, table] of Object.entries(MIRRORS)) {
      const typed = interfaceFields(source, iface);
      if (!typed) {
        drift.push(`${iface}: interface not found in types.ts`);
        continue;
      }
      const allowed = new Set(DELIBERATELY_UNTYPED[table] ?? []);
      const unseen = (columns[table] ?? []).filter(
        (c) => !typed.includes(c) && !allowed.has(c),
      );
      if (unseen.length > 0) drift.push(`${table} → ${iface} is missing: ${unseen.join(', ')}`);
    }

    if (drift.length > 0) {
      console.log('\n  Columns the database has that no code can use:');
      for (const d of drift) console.log(`    ${d}`);
    }
    expect(drift, 'the schema moved and the types did not').toEqual([]);
  });

  it('claims no field the database does not have', () => {
    const phantom: string[] = [];
    for (const [iface, table] of Object.entries(MIRRORS)) {
      const typed = interfaceFields(source, iface) ?? [];
      const real = new Set(columns[table] ?? []);
      const missing = typed.filter((f) => !real.has(f));
      if (missing.length > 0) phantom.push(`${iface} → ${table} claims: ${missing.join(', ')}`);
    }

    if (phantom.length > 0) {
      console.log('\n  Fields the types promise that the database does not have:');
      for (const p of phantom) console.log(`    ${p}`);
    }
    // A select on one of these is a 400 that `(data ?? [])` would turn into an
    // empty table — decision 96's bug, waiting.
    expect(phantom, 'the types promise columns that do not exist').toEqual([]);
  });

  it('prints what it checked', () => {
    const checked = Object.entries(MIRRORS)
      .map(([iface, table]) => `${table}(${(columns[table] ?? []).length})`)
      .join(' ');
    console.log(`\n  ${Object.keys(MIRRORS).length} types checked: ${checked}`);
    const unmirrored = Object.keys(columns)
      .filter((t) => !Object.values(MIRRORS).includes(t))
      .sort();
    console.log(`  ${unmirrored.length} typed in the calc layer: ${unmirrored.join(', ')}`);

    // A NEW table with no type at all should show up here as a surprise, not
    // blend into a list nobody reads.
    const unexpected = unmirrored.filter((t) => !TYPED_IN_THE_CALC_LAYER.includes(t));
    expect(unexpected, 'a table exists that nothing in the codebase types').toEqual([]);
  });
});
