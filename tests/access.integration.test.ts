import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { UserRole } from '@/lib/types';

/**
 * Who may change a role, proved at the database - Spec §23, migration 0028.
 *
 * Every query runs with the ANON key and that person's own access token, which
 * is what a browser sends. A test using the service-role key would prove
 * nothing here: it bypasses RLS by design, and `/api/access` deliberately does
 * NOT use it, so the policies and the trigger are the entire boundary.
 *
 * The riskiest thing in this whole system is the update that decides what every
 * future update is allowed to be. It is worth testing from the outside.
 *
 *   ACCESS_TEST=1 npx vitest run tests/access.integration.test.ts
 */
const ENABLED =
  process.env.ACCESS_TEST === '1' &&
  Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );

const PROBES: Array<{ key: string; role: UserRole }> = [
  { key: 'cfo', role: 'cfo' },
  { key: 'viewer', role: 'viewer' },
  { key: 'target', role: 'employee' },
];

describe.skipIf(!ENABLED)('changing access, as Postgres enforces it', () => {
  let admin: SupabaseClient;
  const clients = new Map<string, SupabaseClient>();
  const ids = new Map<string, string>();
  const password = `Ac-${crypto.randomBytes(12).toString('base64url')}!7`;
  const email = (key: string) => `access-test-${key}@probe.invalid`;

  beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );

    for (const { key, role } of PROBES) {
      const address = email(key);
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

      const { data: row } = await admin
        .from('users')
        .upsert(
          { auth_id: authUser.id, email: address, full_name: `Access ${key}`, role },
          { onConflict: 'email' },
        )
        .select('id')
        .single();
      ids.set(key, (row as { id: string }).id);

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
        key,
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
    for (const { key } of PROBES) {
      const address = email(key);
      await admin.from('users').delete().eq('email', address);
      const authUser = list.users.find((u) => u.email === address);
      if (authUser) await admin.auth.admin.deleteUser(authUser.id);
    }
  }, 120_000);

  it('shows a viewer only their own row', async () => {
    // `p_users_read` is `can_manage_people() or auth_id = auth.uid()`. Anyone
    // without the capability learns nothing about who else exists.
    const { data } = await clients.get('viewer')!.from('users').select('id,email');
    expect(data).toHaveLength(1);
    expect((data as Array<{ email: string }>)[0]!.email).toBe(email('viewer'));
  });

  it('shows a CFO everybody, because a CFO manages people', async () => {
    // 0002 wrote this policy as `is_owner()`, before the seven roles existed —
    // which left the CFO managing people they could not see.
    const { data } = await clients.get('cfo')!.from('users').select('id');
    expect((data ?? []).length).toBeGreaterThan(1);
  });

  it('refuses a viewer trying to promote themselves', async () => {
    // The attack the whole migration exists for. It fails on the write policy
    // before the trigger is even reached.
    const viewer = clients.get('viewer')!;
    await viewer.from('users').update({ role: 'owner' }).eq('id', ids.get('viewer')!);

    const { data } = await admin
      .from('users')
      .select('role')
      .eq('id', ids.get('viewer')!)
      .single();
    expect((data as { role: string }).role, 'a viewer promoted themselves').toBe('viewer');
  });

  it('refuses a viewer trying to promote somebody else', async () => {
    const viewer = clients.get('viewer')!;
    await viewer.from('users').update({ role: 'owner' }).eq('id', ids.get('target')!);

    const { data } = await admin.from('users').select('role').eq('id', ids.get('target')!).single();
    expect((data as { role: string }).role).toBe('employee');
  });

  it('lets a CFO change somebody else, which is the point', async () => {
    const { error } = await clients
      .get('cfo')!
      .from('users')
      .update({ role: 'accountant' })
      .eq('id', ids.get('target')!);
    expect(error).toBeNull();

    const { data } = await admin.from('users').select('role').eq('id', ids.get('target')!).single();
    expect((data as { role: string }).role).toBe('accountant');
  });

  it('refuses a CFO changing their own role', async () => {
    // Any role that can promote itself makes the model advisory. The trigger
    // refuses regardless of which route asked.
    const { error } = await clients
      .get('cfo')!
      .from('users')
      .update({ role: 'owner' })
      .eq('id', ids.get('cfo')!);

    expect(error, 'self-promotion was allowed').not.toBeNull();
    expect(error!.message).toContain('your own role');

    const { data } = await admin.from('users').select('role').eq('id', ids.get('cfo')!).single();
    expect((data as { role: string }).role).toBe('cfo');
  });

  it('refuses re-pointing a row at a different login', async () => {
    // The quieter escalation: leave the role alone and change whose login it
    // belongs to. `auth_id` is what maps a session to this row's permissions.
    const { error } = await clients
      .get('cfo')!
      .from('users')
      .update({ auth_id: crypto.randomUUID() })
      .eq('id', ids.get('target')!);

    expect(error, 'auth_id was re-pointed').not.toBeNull();
    expect(error!.message).toContain('auth_id cannot be changed');
  });

  it('refuses rewriting the email a login was created with', async () => {
    const { error } = await clients
      .get('cfo')!
      .from('users')
      .update({ email: 'someone-else@probe.invalid' })
      .eq('id', ids.get('target')!);

    expect(error).not.toBeNull();
    expect(error!.message).toContain('email cannot be changed');
  });

  it('lets a CFO link a Slack account without touching the role', async () => {
    const { error } = await clients
      .get('cfo')!
      .from('users')
      .update({ slack_user_id: 'U0PROBE123' })
      .eq('id', ids.get('target')!);
    expect(error).toBeNull();

    const { data } = await admin
      .from('users')
      .select('slack_user_id,role')
      .eq('id', ids.get('target')!)
      .single();
    const row = data as { slack_user_id: string; role: string };
    expect(row.slack_user_id).toBe('U0PROBE123');
    expect(row.role).toBe('accountant');
  });

  /*
   * ONE BRANCH THIS FILE DOES NOT COVER, said plainly rather than left for a
   * reader to assume.
   *
   * The trigger also refuses to demote the LAST owner. Reaching that branch
   * requires a moment when exactly one owner exists, and the only owner here is
   * AHN's real account — so exercising it would mean demoting the live
   * company's owner and hoping to put it back. That is a worse risk than the
   * one being tested, and a test that leaves the business without an owner if
   * it crashes halfway is not a safety net.
   *
   * What IS covered: the trigger is installed and firing, proved by the
   * self-role-change refusal above, which comes from the same function. A later
   * migration dropping the trigger would turn that test red. A logic error
   * inside the last-owner branch specifically would not be caught here.
   */
});
