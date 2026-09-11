import type { ReactNode } from 'react';

/**
 * Shared shell for the public legal pages - the privacy policy and the EULA.
 *
 * PUBLIC ON PURPOSE. Both pages sit outside the `(app)` route group, so nothing
 * calls `requireSession()` and no sign-in is needed. Intuit and Plaid both
 * require a reviewer to open these URLs while signed out; a policy behind a
 * login is a policy the reviewer cannot read, which is the whole reason it is
 * being asked for.
 *
 * They share a shell because they must agree with each other. When the two were
 * separate files with separate footers, only one of them knew payroll existed.
 */
export function LegalPage({
  title,
  updated,
  lede,
  children,
}: {
  title: string;
  updated: string;
  lede?: string;
  children: ReactNode;
}) {
  return (
    <main
      style={{
        maxWidth: 760,
        margin: '0 auto',
        padding: '48px 24px 96px',
        lineHeight: 1.65,
      }}
    >
      <h1 style={{ fontSize: 30, fontWeight: 650, letterSpacing: '-0.02em' }}>{title}</h1>
      <p className="muted" style={{ marginTop: 6 }}>
        AHN Financial OS · Last updated {updated}
      </p>
      {lede && (
        <p className="muted" style={{ marginTop: 14, fontSize: 14 }}>
          {lede}
        </p>
      )}
      {children}
    </main>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 17, fontWeight: 620, letterSpacing: '-0.01em' }}>{title}</h2>
      <div style={{ marginTop: 8, fontSize: 14 }}>{children}</div>
    </section>
  );
}

export function A({ href, children }: { href: string; children: ReactNode }) {
  const external = href.startsWith('http');
  return (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
      style={{ textDecoration: 'underline', textUnderlineOffset: 3 }}
    >
      {children}
    </a>
  );
}

/**
 * Each legal page links to the other one.
 *
 * Intuit's review opens whichever URL was entered in the app settings and
 * expects to be able to reach the rest. A reviewer who lands on the EULA and
 * cannot find the privacy policy files that as a finding.
 */
export function LegalFooter({ current }: { current: 'privacy' | 'eula' }) {
  return (
    <p className="faint" style={{ marginTop: 40, fontSize: 12 }}>
      {current === 'privacy' ? (
        <>
          See also the <A href="/eula">End-User License Agreement</A> and{' '}
          <A href="/support">Support</A>. This page describes how the system actually behaves. If
          the system changes, this page is updated with it.
        </>
      ) : (
        <>
          See also the <A href="/privacy">Privacy Policy</A>, which describes what this system
          reads, stores and encrypts, and <A href="/support">Support</A>.
        </>
      )}
    </p>
  );
}
