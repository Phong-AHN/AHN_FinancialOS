import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth';
import { AccessEditor } from '@/components/AccessEditor';
import { ROLE_LABELS, capabilitiesOf } from '@/lib/capabilities';
import type { UserRole } from '@/lib/types';
import { Callout, Card, EmptyState, PageHeader, SectionHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Who has access, and to what - Spec section 23.
 *
 * Roles could only be set with SQL or the create-user script, and after
 * migration 0026 the same was true of linking a Slack account. Both were on
 * AHN's checklist as "run this UPDATE" — no audit trail, no guard rails, and
 * requiring the one credential that can do anything.
 *
 * Nothing on this page is the security boundary. Migration 0028 put write
 * policies and a trigger on `users`; this renders what the database will
 * enforce with or without it.
 */
export default async function AccessPage() {
  const supabase = createSupabaseServerClient();
  const [session, usersRes] = await Promise.all([
    requireSession(),
    supabase.from('users').select('id,email,full_name,role,slack_user_id,created_at').order('created_at'),
  ]);

  /*
   * No capability check here, deliberately.
   *
   * `p_users_read` is `can_manage_people() or auth_id = auth.uid()`, so anyone
   * without the capability gets exactly one row back: their own. That is a
   * useful page rather than a refusal — it answers "what am I allowed to do?"
   * — and it is the database drawing the line rather than an `if` here that
   * could drift away from it.
   */
  const users = (usersRes.data ?? []) as Array<{
    id: string;
    email: string;
    full_name: string | null;
    role: UserRole;
    slack_user_id: string | null;
  }>;

  const canManage = capabilitiesOf(session.user.role).includes('manage_people');
  const owners = users.filter((u) => u.role === 'owner').length;
  const unlinked = users.filter((u) => !u.slack_user_id).length;

  return (
    <>
      <PageHeader
        title="Who has access"
        subtitle="Roles are enforced by Postgres, not by this screen. Changing one here is audited like any other financial control."
      />

      {!canManage && (
        <div className="mb-5">
          <Callout tone="warn" title="You are seeing only your own access">
            Listing everybody needs the people-management capability. This is the database refusing,
            not the page hiding — the same rule applies to anything that queries this table.
          </Callout>
        </div>
      )}

      {canManage && owners === 1 && (
        <div className="mb-5">
          <Callout tone="warn" title="There is exactly one owner">
            If that account is lost, nobody can appoint a replacement from inside the app — the way
            back is the SQL console. The database will refuse to demote the last owner, but it
            cannot stop an account being lost. Appoint a second one.
          </Callout>
        </div>
      )}

      <Card padded={false}>
        <div className="p-4 pb-0">
          <SectionHeader
            title={canManage ? `${users.length} account${users.length === 1 ? '' : 's'}` : 'Your access'}
            subtitle="A role decides what the database will return, before any page asks for it"
          />
        </div>
        {users.length === 0 ? (
          <EmptyState title="No accounts" body="Add one with scripts/create-user.mjs." />
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {users.map((u) => (
              <li key={u.id} className="p-4">
                {canManage ? (
                  <AccessEditor
                    userId={u.id}
                    email={u.email}
                    role={u.role}
                    slackUserId={u.slack_user_id}
                    isSelf={u.id === session.user.id}
                  />
                ) : (
                  <div>
                    <p className="text-[13px] font-medium">{u.email}</p>
                    <p className="muted mt-0.5 text-[12px]">
                      {ROLE_LABELS[u.role]} —{' '}
                      {capabilitiesOf(u.role).length === 0
                        ? 'your own record and hours'
                        : capabilitiesOf(u.role)
                            .map((c) => c.replace(/_/g, ' '))
                            .join(', ')}
                    </p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canManage && unlinked > 0 && (
        <p className="muted mt-4 text-[12.5px]">
          {unlinked} account{unlinked === 1 ? ' has' : 's have'} no Slack member id. Their slash
          commands are refused by name — being in the AHN workspace is not by itself permission to
          read the company&rsquo;s finances.
        </p>
      )}

      <p className="faint mt-4 text-[11px]">
        Adding a new person is still <code>node scripts/create-user.mjs &lt;email&gt; &lt;password&gt;
        &lt;role&gt;</code>: creating a login means creating an auth account, which needs the service
        credential and should not be reachable from a browser session.
      </p>
    </>
  );
}
