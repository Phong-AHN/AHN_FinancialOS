import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * MVP Plan Day 7 / Spec §23: Owner sees everything, Viewer is read-only with
 * payroll detail hidden.
 *
 * Every query here runs with the ANON key plus the viewer's own access token —
 * what a browser sends — so Postgres applies the policies. Using the
 * service-role key would prove nothing: it bypasses RLS by design, which is
 * exactly why the original bug survived so long.
 *
 * The bug these tests exist for: the read policy asked
 * `is_sensitive_category(category)`, but a payroll run is filed as
 * `category='people', subcategory='us_payroll'`. `'people'` matched no
 * sensitive word, so every viewer could read every payroll row — with the
 * policy present, enabled, and reading as though it worked.
 *
 *   RLS_TEST=1 VIEWER_EMAIL=… VIEWER_PASSWORD=… npx vitest run tests/rls.integration.test.ts
 */
const ENABLED =
  process.env.RLS_TEST === '1' &&
  Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
      process.env.VIEWER_EMAIL &&
      process.env.VIEWER_PASSWORD,
  );

describe.skipIf(!ENABLED)('Row Level Security, as a real viewer', () => {
  let admin: SupabaseClient;
  let viewer: SupabaseClient;
  const marker = `rls-test-${Date.now()}`;
  let probeId: string;

  beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );

    const { data: account } = await admin.from('financial_accounts').select('id').limit(1).single();
    const { data, error } = await admin
      .from('transactions')
      .insert({
        account_id: (account as { id: string }).id,
        txn_date: new Date().toISOString().slice(0, 10),
        amount_minor: 1_940_000,
        currency: 'USD',
        direction: 'outflow',
        amount_usd_minor: 1_940_000,
        description: 'Gusto payroll run — US team',
        // Exactly how the categoriser files payroll.
        category: 'people',
        subcategory: 'us_payroll',
        source_system: 'manual',
        external_txn_id: marker,
      })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    probeId = (data as { id: string }).id;

    viewer = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } },
    );
    const { error: signIn } = await viewer.auth.signInWithPassword({
      email: process.env.VIEWER_EMAIL!,
      password: process.env.VIEWER_PASSWORD!,
    });
    if (signIn) throw new Error(`viewer sign-in failed: ${signIn.message}`);
  }, 30_000);

  afterAll(async () => {
    if (probeId) await admin.from('transactions').delete().eq('external_txn_id', marker);
  });

  it('hides payroll from a viewer, however it is filed', async () => {
    const { data } = await viewer
      .from('transactions')
      .select('id,description')
      .eq('external_txn_id', marker);
    expect(data ?? [], 'a viewer can read a payroll transaction').toHaveLength(0);
  });

  it('hides every compensation row, not only ones with "payroll" in the text', async () => {
    // Contractor payments, commissions and bonuses are compensation too.
    const { data } = await viewer.from('transactions').select('category').eq('category', 'people');
    expect(data ?? []).toHaveLength(0);
  });

  it('still lets a viewer read ordinary transactions', async () => {
    // Read-only must not mean blind — the dashboard has to work for them.
    const { data } = await viewer.from('transactions').select('id').limit(5);
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it('hides integration credentials', async () => {
    const { data } = await viewer.from('integrations').select('id,access_token_enc');
    expect(data ?? []).toHaveLength(0);
  });

  it('hides the audit log', async () => {
    const { data } = await viewer.from('audit_logs').select('id').limit(5);
    expect(data ?? []).toHaveLength(0);
  });

  it('refuses a write to a transaction', async () => {
    const { data } = await viewer
      .from('transactions')
      .update({ notes: 'a viewer must not be able to write this' })
      .eq('id', probeId)
      .select('id');
    expect(data ?? []).toHaveLength(0);
  });

  it('lets a viewer read alert rules but not change them', async () => {
    const { data: rules } = await viewer.from('alert_rules').select('id').limit(1);
    expect((rules ?? []).length).toBeGreaterThan(0);

    const { data: written } = await viewer
      .from('alert_rules')
      .update({ enabled: false })
      .eq('id', (rules as Array<{ id: string }>)[0]!.id)
      .select('id');
    expect(written ?? []).toHaveLength(0);
  });

  it('lets a viewer read a project P&L but never write one', async () => {
    // Spec §12 project figures are readable by everyone who can sign in — a
    // viewer is meant to see whether the work made money. Creating a project,
    // editing a contract value or deleting one are financial controls, and the
    // API route's owner check is NOT what stops them: this goes straight at the
    // database with the viewer's own token, the way a script would.
    const { data: readable, error: readError } = await viewer
      .from('projects')
      .select('id,name,contracted_revenue_minor')
      .limit(1);
    expect(readError).toBeNull();

    const insert = await viewer
      .from('projects')
      .insert({ name: `${marker}-should-not-exist`, kind: 'project' })
      .select('id');
    expect(insert.error, 'a viewer created a project').not.toBeNull();

    if ((readable ?? []).length > 0) {
      const id = (readable as Array<{ id: string }>)[0]!.id;
      // A contract value drives every variance measured against it, so a viewer
      // rewriting one would quietly change what the project appears to be worth.
      const update = await viewer
        .from('projects')
        .update({ contracted_revenue_minor: 1 })
        .eq('id', id)
        .select('id');
      expect(update.data ?? [], 'a viewer changed a contract value').toHaveLength(0);

      const remove = await viewer.from('projects').delete().eq('id', id).select('id');
      expect(remove.data ?? [], 'a viewer deleted a project').toHaveLength(0);
    }

    // Business units are admin-configurable per §15 — by the admin.
    const unit = await viewer.from('business_units').insert({ name: `${marker}-unit` }).select('id');
    expect(unit.error, 'a viewer created a business unit').not.toBeNull();
  });

  it('hides what people cost, and the hours that would reveal it', async () => {
    // A rate IS compensation, so §23 restricts it the same way payroll rows are
    // restricted. Hours matter for the same reason and one step removed: a
    // viewer holding both a project's labour cost and its hours can divide one
    // by the other and recover a salary the payroll policy exists to hide.
    const people = await viewer.from('people').select('name,annual_cost_minor,hourly_cost_minor');
    expect(people.data ?? [], 'a viewer read what people cost').toHaveLength(0);

    const time = await viewer.from('time_entries').select('person_id,hours');
    expect(time.data ?? [], 'a viewer read logged hours').toHaveLength(0);

    const write = await viewer
      .from('people')
      .insert({ name: `${marker}-person`, basis: 'hourly', hourly_cost_minor: 1 })
      .select('id');
    expect(write.error, 'a viewer added a person').not.toBeNull();
  });

  it('leaves the owner able to see what the viewer cannot', async () => {
    // Confirms the row exists at all — otherwise every check above would pass
    // for the wrong reason.
    const { data } = await admin.from('transactions').select('id').eq('external_txn_id', marker);
    expect(data ?? []).toHaveLength(1);
  });
});
