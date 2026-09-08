import type { Metadata } from 'next';
import { getSession, sessionCan } from '@/lib/auth';
import { createSupabaseServerClient, isSupabaseConfigured } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Disconnected — AHN Financial OS',
  description: 'What happens after disconnecting AHN Financial OS from QuickBooks.',
};

/**
 * Intuit's Disconnect URL - where QuickBooks sends a user who has just
 * disconnected this app from inside their company file.
 *
 * THIS PAGE DELIBERATELY DESTROYS NOTHING.
 *
 * It is reached by an ordinary browser redirect. Intuit signs nothing, sends no
 * shared secret, and the URL is guessable — it is written in the app settings
 * and in this repository. If landing here deleted the stored tokens, then any
 * crawler, any link preview, any prefetch, and anybody who has ever seen the
 * URL could sever AHN's accounting connection by loading a page. That is a
 * denial-of-service control handed to the public, and no amount of "but only
 * Intuit knows to send people here" makes it one.
 *
 * There is also nothing urgent to do. By the time somebody arrives here Intuit
 * has ALREADY revoked the grant at their end — that is what the user just did.
 * Our stored copy is dead weight, not a live credential. Clearing it is
 * housekeeping, and housekeeping can wait for somebody who is signed in.
 *
 * So: the page reports, and the authenticated route at
 * `/api/integrations/[id]` does the clearing. Anonymous visitors see an
 * explanation and no data — the counts below are read only when a session with
 * `move_money` is present, so this page tells a stranger nothing about AHN.
 */
export default async function DisconnectPage() {
  const session = await getSession();
  const mayManage = sessionCan(session, 'move_money');

  // Read only for somebody entitled to see it. An anonymous visitor gets the
  // explanation and nothing else.
  let stale = 0;
  if (mayManage && isSupabaseConfigured()) {
    const db = createSupabaseServerClient();
    const { count } = await db
      .from('integrations')
      .select('id', { count: 'exact', head: true })
      .eq('provider', 'quickbooks')
      .not('refresh_token_enc', 'is', null);
    stale = count ?? 0;
  }

  return (
    <main
      style={{
        maxWidth: 560,
        margin: '0 auto',
        padding: '80px 24px 96px',
        lineHeight: 1.65,
      }}
    >
      <h1 style={{ fontSize: 24, fontWeight: 650, letterSpacing: '-0.02em' }}>
        QuickBooks has been disconnected
      </h1>

      <p className="muted" style={{ marginTop: 12, fontSize: 14 }}>
        AHN Financial OS no longer has access to that QuickBooks company. Intuit revoked the
        connection when you disconnected it, so no further data will be read.
      </p>

      <p className="muted" style={{ marginTop: 12, fontSize: 14 }}>
        Financial records already imported are kept — they are AHN&rsquo;s own accounting history,
        not QuickBooks&rsquo; copy of it. Nothing is deleted by disconnecting.
      </p>

      {mayManage ? (
        stale > 0 ? (
          <div
            style={{
              marginTop: 24,
              padding: '14px 16px',
              borderRadius: 10,
              background: 'var(--surface-sunk)',
              fontSize: 13.5,
            }}
          >
            <p>
              <strong>
                {stale} stored QuickBooks credential{stale === 1 ? '' : 's'} still to clear.
              </strong>
            </p>
            <p className="muted" style={{ marginTop: 6 }}>
              This page will not clear them, because anybody can open it. Disconnect the connection
              on the Integrations page and the stored tokens are revoked and deleted there.
            </p>
            <p style={{ marginTop: 10 }}>
              <a href="/integrations" style={{ textDecoration: 'underline', textUnderlineOffset: 3 }}>
                Go to Integrations →
              </a>
            </p>
          </div>
        ) : (
          <p className="muted" style={{ marginTop: 24, fontSize: 14 }}>
            No stored QuickBooks credentials remain in this system.{' '}
            <a href="/integrations" style={{ textDecoration: 'underline', textUnderlineOffset: 3 }}>
              Integrations
            </a>
          </p>
        )
      ) : (
        <p className="muted" style={{ marginTop: 24, fontSize: 14 }}>
          To reconnect, or to clear the credentials this system still holds,{' '}
          <a
            href="/login?next=%2Fintegrations"
            style={{ textDecoration: 'underline', textUnderlineOffset: 3 }}
          >
            sign in
          </a>
          . Access is restricted to invited AHN accounts.
        </p>
      )}

      <p className="faint" style={{ marginTop: 40, fontSize: 12 }}>
        <a href="/privacy" style={{ textDecoration: 'underline', textUnderlineOffset: 3 }}>
          Privacy policy
        </a>
        {' · '}
        <a href="/eula" style={{ textDecoration: 'underline', textUnderlineOffset: 3 }}>
          End-User License Agreement
        </a>
      </p>
    </main>
  );
}
