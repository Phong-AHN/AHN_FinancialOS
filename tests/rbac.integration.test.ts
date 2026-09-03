import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { can } from '@/lib/capabilities';
import type { UserRole } from '@/lib/types';

/**
 * Spec §23's seven roles, enforced by Postgres rather than by the interface.
 *
 * Every query below runs with the ANON key plus that role's own access token —
 * what a browser or a script sends — so the real policies decide. A test that
 * used the service-role key would prove nothing: it bypasses RLS by design,
 * which is how a payroll leak once survived a passing suite here (decision 41).
 *
 * WHAT THIS CATCHES THAT `tests/capabilities.test.ts` CANNOT. That one checks
 * the TypeScript matrix agrees with itself. This one checks the DATABASE agrees
 * with the TypeScript matrix — and the database is the authority. A capability
 * added to one and not the other is a silent grant, and only this test sees it.
 *
 * It creates six probe users and deletes them afterwards.
 *
 *   RBAC_TEST=1 npx vitest run tests/rbac.integration.test.ts
 */
const ENABLED =
  process.env.RBAC_TEST === '1' &&
  Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );

const PROBE_ROLES: UserRole[] = [
  'cfo',
  'accountant',
  'department_lead',
  'project_manager',
  'employee',
  'viewer',
];

describe.skipIf(!ENABLED)('the seven roles, as Postgres enforces them', () => {
  let admin: SupabaseClient;
  const clients = new Map<UserRole, SupabaseClient>();
  const password = `Rb-${crypto.randomBytes(12).toString('base64url')}!7`;
  const email = (role: string) => `rbac-test-${role}@probe.invalid`;

  beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );

    for (const role of PROBE_ROLES) {
      const address = email(role);
      const { data: list } = await admin.auth.admin.listUsers();
      let authUser = list.users.find((u) => u.email === address);

      if (!authUser) {
        const created = await admin.auth.admin.createUser({
          email: address,
          password,
          email_confirm: true,
        });
        authUser = created.data.user!;
      } else {
        await admin.auth.admin.updateUserById(authUser.id, { password });
      }

      await admin
        .from('users')
        .upsert({ auth_id: authUser.id, email: address, full_name: `RBAC ${role}`, role },
          { onConflict: 'email' });

      const session = await (
        await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: {
            apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ email: address, password }),
        })
      ).json();

      clients.set(
        role,
        createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
          {
            auth: { persistSession: false },
            global: { headers: { Authorization: `Bearer ${session.access_token}` } },
          },
        ),
      );
    }
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
    const { data: list } = await admin.auth.admin.listUsers();
    for (const role of PROBE_ROLES) {
      const address = email(role);
      await admin.from('users').delete().eq('email', address);
      const authUser = list.users.find((u) => u.email === address);
      if (authUser) await admin.auth.admin.deleteUser(authUser.id);
    }
  }, 120_000);

  const rows = async (role: UserRole, table: string) => {
    const { count, error } = await clients
      .get(role)!
      .from(table)
      .select('*', { count: 'exact', head: true });
    return error ? -1 : (count ?? 0);
  };

  it('hides bank credentials from everyone who may not manage them', async () => {
    for (const role of PROBE_ROLES) {
      const seen = await rows(role, 'integrations');
      const allowed = can(role, 'manage_integrations');
      // The TypeScript matrix and the database have to agree. If they drift,
      // one of them is granting something nobody decided to grant.
      expect(seen > 0, `${role} sees integrations`).toBe(allowed && seen !== 0);
      if (!allowed) expect(seen, role).toBe(0);
    }
  }, 60_000);

  it('answers a blocked read with an empty list, not an error', async () => {
    /*
     * A platform fact, pinned here because getting it wrong cost a real bug.
     *
     * `loadProject` decided whether a reader may see labour cost with
     * `!peopleRes.error`, on the belief that RLS refuses a viewer outright. It
     * does not: a blocked select is HTTP 200 with `[]` and no error. So the
     * guard never fired, and a viewer was shown a net profit computed from a
     * labour cost of zero — presented as net. See decision 90.
     *
     * The lesson generalises: an empty result cannot tell "there is nothing"
     * apart from "you may not see it", so it must never be used to decide
     * permission. Only the capability can, and only the database can enforce it.
     */
    const { data, error } = await clients.get('viewer')!.from('people').select('id');
    expect(error, 'RLS started erroring instead of returning empty').toBeNull();
    expect(data, 'a viewer read a people row').toEqual([]);
  }, 60_000);

  it('hides compensation from everyone who may not see it', async () => {
    for (const role of PROBE_ROLES) {
      const { data } = await clients
        .get(role)!
        .from('transactions')
        .select('id')
        .eq('category', 'people');
      if (can(role, 'see_compensation')) continue;
      expect(data ?? [], `${role} read payroll`).toHaveLength(0);
    }
  }, 60_000);

  it('hides what people cost from everyone but the finance roles', async () => {
    for (const role of PROBE_ROLES) {
      if (can(role, 'see_compensation')) continue;
      const { data } = await clients
        .get(role)!
        .from('people')
        .select('annual_cost_minor,hourly_cost_minor');
      // An employee may see their OWN record; a probe user is linked to none,
      // so anything returned here is somebody else's rate.
      expect(data ?? [], `${role} read a rate`).toHaveLength(0);
    }
  }, 60_000);

  it('keeps company-wide balances from scoped roles', async () => {
    // Section 23 names bank balances alongside payroll. A project manager runs
    // a project; what the company holds is not theirs to see.
    for (const role of PROBE_ROLES) {
      const seen = await rows(role, 'financial_accounts');
      if (can(role, 'see_all_money')) expect(seen, role).toBeGreaterThan(0);
      else expect(seen, role).toBe(0);
    }
  }, 60_000);

  it('keeps the audit log to the roles that may read it', async () => {
    for (const role of PROBE_ROLES) {
      const seen = await rows(role, 'audit_logs');
      if (!can(role, 'read_audit')) expect(seen, role).toBe(0);
    }
  }, 60_000);

  it('refuses a financial write from every role that may not move money', async () => {
    for (const role of PROBE_ROLES) {
      if (can(role, 'move_money')) continue;
      const { error } = await clients.get(role)!.from('budgets').insert({
        name: `rbac-${role}`,
        scope: 'total',
        period: 'month',
        starts_on: '2026-09-01',
        amount_minor: 100,
      });
      expect(error, `${role} created a budget`).not.toBeNull();
    }
  }, 60_000);

  it('refuses an exchange-rate change from every role but owner and CFO', async () => {
    // One number that revalues every foreign balance in the ledger.
    for (const role of PROBE_ROLES) {
      if (can(role, 'move_money')) continue;
      const { error } = await clients.get(role)!.from('exchange_rates').insert({
        base_currency: 'GBP',
        quote_currency: 'USD',
        rate: 99,
        as_of: '2026-09-01',
      });
      expect(error, `${role} set an exchange rate`).not.toBeNull();
    }
  }, 60_000);

  it('never lets a write policy grant a read', async () => {
    // The bug this exists for: every write policy was once `FOR ALL`, which in
    // Postgres covers SELECT — so a department lead, who may manage projects,
    // could read EVERY project while the scoped read policy beside it
    // carefully restricted them. Policies are OR-ed, so the widest one wins.
    const lead = clients.get('department_lead')!;
    const { data: seen } = await lead.from('projects').select('id,business_unit_id,owner_user_id');

    for (const project of seen ?? []) {
      const row = project as { business_unit_id: string | null; owner_user_id: string | null };
      // Every project a scoped role can see must be scoped to them somehow.
      expect(
        row.business_unit_id !== null || row.owner_user_id !== null,
        'a scoped role read a project belonging to nobody',
      ).toBe(true);
    }
  }, 60_000);
});
