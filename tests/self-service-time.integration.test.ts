import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * An employee logging their own hours - Spec §13, migration 0029.
 *
 * Every write below runs with the ANON key plus the employee's own access
 * token, which is what a browser sends. The API route is not in the picture at
 * all: the policies are the boundary, and the point of this file is that they
 * hold with no application code helping.
 *
 * The dangerous version of this feature is one where "let people log their own
 * time" quietly becomes "let people log anyone's time" — which changes a
 * colleague's cost, and through it a project's margin.
 *
 *   TIME_TEST=1 npx vitest run tests/self-service-time.integration.test.ts
 */
const ENABLED =
  process.env.TIME_TEST === '1' &&
  Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );

const EMAIL = 'time-test-employee@probe.invalid';

/** YYYY-MM-DD, `days` from today. */
const day = (offset: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

describe.skipIf(!ENABLED)('logging your own hours, as Postgres enforces it', () => {
  let admin: SupabaseClient;
  let employee: SupabaseClient;
  let authId = '';
  let appUserId = '';
  let mePersonId = '';
  let otherPersonId = '';
  let projectId = '';

  beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );

    const password = `Tm-${crypto.randomBytes(12).toString('base64url')}!7`;
    const { data: list } = await admin.auth.admin.listUsers();
    let user = list.users.find((u) => u.email === EMAIL);
    if (!user) {
      const created = await admin.auth.admin.createUser({
        email: EMAIL,
        password,
        email_confirm: true,
      });
      user = created.data.user!;
    } else {
      await admin.auth.admin.updateUserById(user.id, { password });
    }
    authId = user.id;

    const { data: appUser } = await admin
      .from('users')
      .upsert(
        { auth_id: authId, email: EMAIL, full_name: 'Time probe', role: 'employee' },
        { onConflict: 'email' },
      )
      .select('id')
      .single();
    appUserId = (appUser as { id: string }).id;

    const { data: me } = await admin
      .from('people')
      .insert({
        name: 'PROBE Me',
        kind: 'employee',
        basis: 'salaried',
        annual_cost_minor: 9_600_000,
        annual_hours: 1880,
        user_id: appUserId,
      })
      .select('id')
      .single();
    mePersonId = (me as { id: string }).id;

    const { data: other } = await admin
      .from('people')
      .insert({
        name: 'PROBE Colleague',
        kind: 'employee',
        basis: 'salaried',
        annual_cost_minor: 24_000_000,
        annual_hours: 1880,
      })
      .select('id')
      .single();
    otherPersonId = (other as { id: string }).id;

    const { data: company } = await admin.from('companies').select('id').limit(1).single();
    const { data: project } = await admin
      .from('projects')
      .insert({
        company_id: (company as { id: string }).id,
        name: 'PROBE Timesheet Project',
        kind: 'project',
        status: 'active',
        contracted_revenue_minor: 5_000_000,
      })
      .select('id')
      .single();
    projectId = (project as { id: string }).id;

    const session = await (
      await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: {
          apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: EMAIL, password }),
      })
    ).json();

    employee = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${session.access_token}` } },
      },
    );
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.from('time_entries').delete().in('person_id', [mePersonId, otherPersonId]);
    await admin.from('people').delete().in('id', [mePersonId, otherPersonId]);
    await admin.from('projects').delete().eq('id', projectId);
    await admin.from('users').delete().eq('email', EMAIL);
    if (authId) await admin.auth.admin.deleteUser(authId);
  }, 120_000);

  it('can log its own hours for today', async () => {
    const { error } = await employee.from('time_entries').insert({
      person_id: mePersonId,
      project_id: projectId,
      work_date: day(0),
      hours: 6.5,
      notes: 'probe',
    });
    expect(error, error?.message).toBeNull();
  });

  it('cannot log hours as somebody else', async () => {
    // The failure that matters. Logging against a colleague changes that
    // colleague's cost, and through it a project's margin.
    const { error } = await employee.from('time_entries').insert({
      person_id: otherPersonId,
      project_id: projectId,
      work_date: day(0),
      hours: 8,
    });
    expect(error, 'an employee logged time as a colleague').not.toBeNull();

    const { count } = await admin
      .from('time_entries')
      .select('*', { count: 'exact', head: true })
      .eq('person_id', otherPersonId);
    expect(count).toBe(0);
  });

  it('cannot restate a month-old timesheet', async () => {
    // Hours feed project profitability. Rewriting them long afterwards silently
    // restates a margin somebody has already reported.
    const { error } = await employee.from('time_entries').insert({
      person_id: mePersonId,
      project_id: projectId,
      work_date: day(-30),
      hours: 8,
    });
    expect(error, 'an employee backdated a timesheet a month').not.toBeNull();
  });

  it('can correct yesterday', async () => {
    const { error } = await employee.from('time_entries').insert({
      person_id: mePersonId,
      project_id: projectId,
      work_date: day(-1),
      hours: 3,
    });
    expect(error, error?.message).toBeNull();

    const { error: updateError } = await employee
      .from('time_entries')
      .update({ hours: 4 })
      .eq('person_id', mePersonId)
      .eq('work_date', day(-1));
    expect(updateError, updateError?.message).toBeNull();

    const { data } = await admin
      .from('time_entries')
      .select('hours')
      .eq('person_id', mePersonId)
      .eq('work_date', day(-1))
      .single();
    expect(Number((data as { hours: number }).hours)).toBe(4);
  });

  it('cannot hand its own entry to somebody else by editing it', async () => {
    // `with check` has to be as strict as `using`, or the row can be moved out
    // from under the rule that allowed the edit.
    const { error } = await employee
      .from('time_entries')
      .update({ person_id: otherPersonId })
      .eq('person_id', mePersonId)
      .eq('work_date', day(0));
    expect(error, 'an entry was reassigned to a colleague').not.toBeNull();
  });

  it('sees project names to log against, and no money with them', async () => {
    // Without this the feature is impossible: an employee owns no project and
    // leads no unit, so `scoped_project_ids()` gives them nothing to pick.
    const { data, error } = await employee.from('projects_for_time').select('*');
    expect(error, error?.message).toBeNull();

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.id === projectId)).toBe(true);

    // The whole reason the view exists rather than a broadened policy.
    for (const key of ['contracted_revenue_minor', 'invoiced_revenue_minor', 'budget_expense_minor']) {
      expect(Object.keys(rows[0]!), `${key} leaked into the picker`).not.toContain(key);
    }
  });

  it('still cannot read the projects table itself', async () => {
    const { data } = await employee.from('projects').select('id,contracted_revenue_minor');
    expect(data ?? []).toHaveLength(0);
  });

  it('still cannot see a colleague, or what they cost', async () => {
    const { data } = await employee.from('people').select('id,name,annual_cost_minor');
    const rows = (data ?? []) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual([mePersonId]);
  });
});
