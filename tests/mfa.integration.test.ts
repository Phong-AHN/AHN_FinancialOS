import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import pg from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { totp } from './helpers/totp';

/**
 * Two-factor authentication, proved at the database (migration 0040).
 *
 * The application sends a half-signed-in person to the MFA pages, but routing
 * is not protection. What matters is what a token can READ — so this signs a
 * throwaway owner in with a password alone and asks the database directly,
 * through the public anon key, the way somebody holding a stolen password
 * would. Then it completes the second factor and asks again.
 *
 * The throwaway user is an OWNER on purpose: every permissive policy then says
 * yes, so the only thing that can say no at aal1 is the MFA policy under test.
 * It is deleted afterwards whatever happens. AHN's real accounts are never
 * signed in to.
 *
 *   MFA_TEST=1 npx vitest run tests/mfa.integration.test.ts
 */
const ENABLED =
  process.env.MFA_TEST === '1' &&
  Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.SUPABASE_DB_URL,
  );

/** A spread of what matters: money, credentials, payroll, the audit trail. */
const PROTECTED = ['transactions', 'financial_accounts', 'integrations', 'payroll_runs', 'audit_logs', 'users'];

describe.skipIf(!ENABLED)('two-factor authentication at the database', () => {
  let admin: SupabaseClient;
  let userId: string | null = null;
  let appUserId: string | null = null;
  const email = `probe-mfa-${Date.now()}@probe.invalid`;
  const password = crypto.randomBytes(18).toString('base64url');
  let oneFactor: SupabaseClient;
  let twoFactor: SupabaseClient;

  const asUser = (token: string) =>
    createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { persistSession: false },
      global: { headers: { authorization: `Bearer ${token}` } },
    });

  beforeAll(async () => {
    admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
    });

    const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    userId = created.user.id;

    const { data: row, error: rowError } = await admin
      .from('users')
      .insert({ email, role: 'owner', auth_id: userId, full_name: 'PROBE mfa' })
      .select('id')
      .single();
    if (rowError) throw rowError;
    appUserId = (row as { id: string }).id;

    // Signed in with a password — exactly what a stolen password buys.
    const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { persistSession: false },
    });
    const { data: signed, error: signError } = await client.auth.signInWithPassword({ email, password });
    if (signError) throw signError;
    oneFactor = asUser(signed.session!.access_token);

    // And then the second factor, as a person with a phone would.
    const { data: factor, error: enrollError } = await client.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'probe',
    });
    if (enrollError) throw enrollError;
    const { data: verified, error: verifyError } = await client.auth.mfa.challengeAndVerify({
      factorId: factor.id,
      code: totp(factor.totp.secret),
    });
    if (verifyError) throw verifyError;
    twoFactor = asUser(verified.access_token);
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
    if (appUserId) await admin.from('users').delete().eq('id', appUserId);
    if (userId) await admin.auth.admin.deleteUser(userId);
  });

  it.each(PROTECTED)('a password alone reads nothing from %s', async (table) => {
    const { data, error } = await oneFactor.from(table).select('*').limit(5);
    // RLS answers a refused SELECT with an empty result, not an error — which
    // is why "empty" is the assertion, and why the two-factor test below must
    // show the same table is NOT empty, or this would prove nothing.
    expect(error).toBeNull();
    expect(data, `${table} is readable with one factor`).toEqual([]);
  });

  it('a password alone cannot list project names through the view', async () => {
    const { data } = await oneFactor.from('projects_for_time').select('*').limit(5);
    expect(data ?? []).toEqual([]);
  });

  /** A row that is valid — so a refusal can only be the policy, not the schema. */
  const scenario = () => ({
    name: `PROBE mfa write ${Date.now()}`,
    revenue_growth_rate: 0.05,
    expense_growth_rate: 0.02,
    months: 12,
    target_margin_ratio: null,
    margin_basis: null,
    baseline_revenue_usd_minor: 100_000,
    baseline_expense_usd_minor: 80_000,
    baseline_months_sampled: 3,
    baseline_as_of: '2026-09-01',
    notes: null,
    created_by: appUserId,
  });

  it('a password alone cannot write — and the same row CAN be written with two factors', async () => {
    const refused = await oneFactor.from('scenarios').insert(scenario()).select('id');
    expect(refused.error, 'a one-factor session wrote a row').not.toBeNull();
    expect(refused.error?.message).toMatch(/row-level security/i);

    // Without this half, a refusal could just as well be a malformed row.
    const accepted = await twoFactor.from('scenarios').insert(scenario()).select('id').single();
    expect(accepted.error, accepted.error?.message).toBeNull();
    await admin.from('scenarios').delete().eq('id', (accepted.data as { id: string }).id);
  });

  it('two factors read the same tables — so the refusals above are the policy, not an empty database', async () => {
    const readable: string[] = [];
    for (const table of ['transactions', 'financial_accounts', 'integrations', 'users']) {
      const { data } = await twoFactor.from(table).select('id').limit(1);
      if ((data ?? []).length > 0) readable.push(table);
    }
    console.log(`\n  readable with two factors: ${readable.join(', ')}`);
    expect(readable).toEqual(['transactions', 'financial_accounts', 'integrations', 'users']);
  });

  it('every table in the schema carries the policy — including ones added after migration 0040', async () => {
    const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      const { rows } = await client.query<{ relname: string }>(`
        select c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and not exists (
            select 1 from pg_policies p
            where p.schemaname = 'public' and p.tablename = c.relname
              and p.policyname = 'p_require_mfa' and p.permissive = 'RESTRICTIVE'
          )`);
      expect(
        rows.map((r) => r.relname),
        'a table without p_require_mfa — add it in the migration that creates the table',
      ).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
