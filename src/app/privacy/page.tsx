import type { Metadata } from 'next';

/**
 * Privacy policy - required by Plaid before Link may be deployed.
 *
 * PUBLIC ON PURPOSE. It sits outside the `(app)` route group, so nothing calls
 * `requireSession()` and no sign-in is needed. A policy behind a login is a
 * policy the reviewer cannot read, which is the whole reason it is being asked
 * for.
 *
 * Everything below describes what this system actually does, verified against
 * the code: which providers are read, what is stored, what is encrypted and
 * how, and that there is no export path. If the system changes, this page has
 * to change with it — a privacy policy that has drifted from the software is
 * worse than none, because it is a written claim that is no longer true.
 */
export const metadata: Metadata = {
  title: 'Privacy Policy — AHN Financial OS',
  description:
    'How AHN Media handles financial data in its internal financial operations system.',
};

const UPDATED = '4 September 2026';

export default function PrivacyPage() {
  return (
    <main
      style={{
        maxWidth: 760,
        margin: '0 auto',
        padding: '48px 24px 96px',
        lineHeight: 1.65,
      }}
    >
      <h1 style={{ fontSize: 30, fontWeight: 650, letterSpacing: '-0.02em' }}>Privacy Policy</h1>
      <p className="muted" style={{ marginTop: 6 }}>
        AHN Financial OS · Last updated {UPDATED}
      </p>

      <Section title="What this application is">
        <p>
          AHN Financial OS is an <strong>internal financial operations system</strong> built and
          used by AHN Media LLC and AHN Vietnam Co. Ltd (together, &ldquo;AHN&rdquo;). It is not a
          consumer product and is not offered to the public.
        </p>
        <p>
          The only financial accounts connected to it are <strong>AHN&rsquo;s own company
          accounts</strong>. The only people who use it are AHN&rsquo;s own staff and contractors,
          each with a named login. There are no external end users, and we do not process anyone
          else&rsquo;s personal financial data.
        </p>
      </Section>

      <Section title="What we collect, and from where">
        <p>
          We read data from financial providers that AHN has connected to its own accounts:
        </p>
        <ul>
          <li>
            <strong>Plaid</strong> — bank and credit-card transactions, account balances, account
            names, types and the last four digits of account numbers.
          </li>
          <li>
            <strong>QuickBooks Online</strong> — cash-affecting entries, invoices and bills.
          </li>
          <li>
            <strong>Stripe</strong> — balance transactions and processing fees.
          </li>
          <li>
            <strong>VietinBank, Finverse, VEEM</strong> — Vietnamese bank statements and
            cross-border payments, where configured.
          </li>
          <li>
            <strong>Files AHN uploads</strong> — bank and payroll statements imported as CSV.
          </li>
        </ul>
        <p>
          Some of this necessarily includes the names of people and businesses AHN pays or is paid
          by, because that is what appears on a bank statement. Where AHN records what its own
          staff cost, that information is restricted to the owner and finance roles by
          database-level access rules.
        </p>
      </Section>

      <Section title="Why we hold it">
        <p>
          To run AHN&rsquo;s finances: cash position, burn rate, runway, break-even, budgets,
          project profitability, receivables and payables, and alerts when money moves. It is
          bookkeeping and internal reporting for our own company.
        </p>
        <p>
          <strong>We never use it to make decisions about anyone outside AHN.</strong> It is not
          used for lending, credit scoring, identity verification, marketing, or any automated
          decision about a person.
        </p>
      </Section>

      <Section title="What we never do">
        <ul>
          <li>We do not sell data, and we do not share it with third parties.</li>
          <li>We do not use it for advertising or marketing of any kind.</li>
          <li>
            We do not move money. The system reads from financial providers; it cannot initiate a
            payment or a transfer.
          </li>
          <li>There is no export feature — no route in the application produces a data file.</li>
        </ul>
      </Section>

      <Section title="How it is protected">
        <ul>
          <li>
            Data is held in a managed <strong>Supabase Postgres</strong> database, encrypted at
            rest at the storage layer.
          </li>
          <li>
            Provider access and refresh tokens are additionally encrypted at the application layer
            with <strong>AES-256-GCM</strong> before being written, using a key that is never
            stored in the database. A database copy alone does not yield a working bank
            connection.
          </li>
          <li>
            <strong>Row Level Security</strong> is enabled on every table, so who may read what is
            enforced by the database itself rather than by the interface. Staff see only what
            their role permits; compensation is restricted further.
          </li>
          <li>
            Every change to a financial record is written to an append-only audit trail recording
            who changed what, when, and from what to what.
          </li>
          <li>All access requires an individual named login. Transport is HTTPS throughout.</li>
        </ul>
      </Section>

      <Section title="How long we keep it">
        <p>
          Financial records are kept for as long as AHN needs them for accounting, tax and audit
          purposes, and for any period required by law in the United States and Vietnam. When a
          provider is disconnected, the stored access tokens for it are removed.
        </p>
      </Section>

      <Section title="Plaid">
        <p>
          When AHN connects a bank account, that connection is made through Plaid Inc. Plaid
          collects the credentials entered in its own interface — <strong>those credentials are
          never seen by, or passed through, this application</strong>. Plaid&rsquo;s handling of
          that information is governed by its own policy:{' '}
          <a
            href="https://plaid.com/legal/#end-user-privacy-policy"
            target="_blank"
            rel="noreferrer"
            style={{ textDecoration: 'underline', textUnderlineOffset: 3 }}
          >
            plaid.com/legal
          </a>
          .
        </p>
        <p>
          AHN can disconnect any linked account at any time from the Integrations page, which
          revokes the stored token.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions about this policy, or a request concerning data held about you, can be sent
          to{' '}
          <a
            href="mailto:team@asianhustlenetwork.com"
            style={{ textDecoration: 'underline', textUnderlineOffset: 3 }}
          >
            team@asianhustlenetwork.com
          </a>
          .
        </p>
      </Section>

      <p className="faint" style={{ marginTop: 40, fontSize: 12 }}>
        This page describes how the system actually behaves. If the system changes, this page is
        updated with it.
      </p>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 17, fontWeight: 620, letterSpacing: '-0.01em' }}>{title}</h2>
      <div style={{ marginTop: 8, fontSize: 14 }}>{children}</div>
    </section>
  );
}
