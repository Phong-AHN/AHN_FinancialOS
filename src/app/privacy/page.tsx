import type { Metadata } from 'next';
import { A, LegalFooter, LegalPage, Section } from '@/components/legal';

/**
 * Privacy policy - required by Plaid before Link may be deployed, and by Intuit
 * before it issues production keys.
 *
 * PUBLIC ON PURPOSE, for the reason given in `components/legal.tsx`.
 *
 * Everything below describes what this system actually does, verified against
 * the code: which providers are read, what is stored, what is encrypted and
 * how, and that there is no export path.
 *
 * IT HAS NOW HAD TO CHANGE FOUR TIMES, each in the same direction — the page
 * claiming something the software did not do:
 *
 *   - It said "we do not move money", true when written and false the day
 *     payroll landed (decision 102).
 *   - It said AHN could disconnect a provider "from the Integrations page,
 *     which revokes the stored token". There was no such control and no revoke
 *     call anywhere in the codebase. Rather than soften the sentence, the
 *     control was built and the token really is revoked at Intuit — see
 *     `/api/integrations/[id]` (decision 103).
 *
 *   - Alerts had been sent through Slack, Resend and Twilio since week one,
 *     carrying amounts and counterparties, while this page said "we do not
 *     share it with third parties" and named none of them. Found while
 *     answering Intuit's question about who can see a customer's data
 *     (decision 109); the services are now named, with what they carry.
 *   - Error logs arrived (decision 107) with a promise that they may be shared
 *     with a provider's support. "We do not share it with third parties" was
 *     about financial data and stays true, but a new kind of record that CAN
 *     leave needed its own paragraph the same day, not later.
 *
 * The lesson every time: a privacy policy that has drifted from the software is
 * worse than none, because it is a written claim, made to a reviewer, that is
 * no longer true. Update it in the same change as the behaviour.
 */
export const metadata: Metadata = {
  title: 'Privacy Policy — AHN Financial OS',
  description:
    'How AHN Media handles financial data in its internal financial operations system.',
};

const UPDATED = '11 September 2026';

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated={UPDATED}>
      <Section title="What this application is">
        <p>
          AHN Financial OS is an <strong>internal financial operations system</strong> built and
          used by AHN Media LLC and AHN Vietnam Co. Ltd (together, &ldquo;AHN&rdquo;). It is not a
          consumer product and is not offered to the public. It reads AHN&rsquo;s financial
          accounts, and it pays AHN&rsquo;s own staff and contractors — see below.
        </p>
        <p>
          The only financial accounts connected to it are{' '}
          <strong>AHN&rsquo;s own company accounts</strong>. The only people who use it are
          AHN&rsquo;s own staff and contractors, each with a named login. There are no external end
          users, and we do not process anyone else&rsquo;s personal financial data.
        </p>
      </Section>

      <Section title="What we collect, and from where">
        <p>We read data from financial providers that AHN has connected to its own accounts:</p>
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
          by, because that is what appears on a bank statement. Where AHN records what its own staff
          cost, that information is restricted to the owner and finance roles by database-level
          access rules.
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
          <li>
            We do not sell data, and we do not share it with third parties — beyond the delivery
            services, named below, that carry alerts to AHN&rsquo;s own staff.
          </li>
          <li>We do not use it for advertising or marketing of any kind.</li>
          <li>
            We do not send payments to anyone who is not an AHN worker. The system pays our own
            staff and contractors, and nobody else.
          </li>
          <li>There is no export feature — no route in the application produces a data file.</li>
        </ul>
      </Section>

      <Section title="Paying our own people">
        <p>
          AHN uses this system to pay its own staff and contractors through <strong>VEEM</strong>.
          Only the recipient&rsquo;s name, email address and country are sent to VEEM, together with
          the amount — the same details that would appear on any payment instruction.
        </p>
        <p>
          No payment can be sent by one person acting alone: a run is prepared by one member of
          finance and must be approved by a different one before anything leaves. Every step is
          written to the audit trail, and we never send payments to anyone who is not an AHN worker.
        </p>
        <p>
          We do not read bank credentials to do this, and we hold no card or bank account numbers
          for recipients — VEEM holds those, under{' '}
          <A href="https://www.veem.com/privacy-policy/">its own policy</A>.
        </p>
      </Section>

      <Section title="How it is protected">
        <ul>
          <li>
            Data is held in a managed <strong>Supabase Postgres</strong> database, encrypted at rest
            at the storage layer.
          </li>
          <li>
            Provider access and refresh tokens are additionally encrypted at the application layer
            with <strong>AES-256-GCM</strong> before being written, using a key that is never stored
            in the database. A database copy alone does not yield a working bank connection.
          </li>
          <li>
            <strong>Row Level Security</strong> is enabled on every table, so who may read what is
            enforced by the database itself rather than by the interface. Staff see only what their
            role permits; compensation is restricted further.
          </li>
          <li>
            Every change to a financial record is written to an append-only audit trail recording
            who changed what, when, and from what to what.
          </li>
          <li>
            All access requires an individual named login <strong>and</strong> a code from an
            authenticator app. Two-factor sign-in is mandatory for every account and is enforced by
            the database itself: a password on its own reads nothing. Transport is HTTPS throughout.
          </li>
        </ul>
      </Section>

      <Section title="Alerts">
        <p>
          When money moves, the system can send an alert. An alert carries what a person needs to
          recognise the payment: the amount, the other party, the account and the resulting
          balance. Alerts go <strong>only to destinations AHN configures for its own staff</strong>{' '}
          — AHN&rsquo;s Slack workspace, AHN email addresses, and AHN staff phone numbers — through
          these delivery services:
        </p>
        <ul>
          <li>
            <strong>Slack</strong> — messages to AHN&rsquo;s own workspace and channels.
          </li>
          <li>
            <strong>Resend</strong> — email.
          </li>
          <li>
            <strong>Twilio</strong> — text messages, which carry only a short summary.
          </li>
        </ul>
        <p>
          These services deliver the message; they are not given access to the system or to
          anything beyond the alert itself. Data from a provider&rsquo;s test environment — a
          QuickBooks sandbox company, for instance — never produces an alert.
        </p>
      </Section>

      <Section title="Error records">
        <p>
          When a connected provider returns an error, the system keeps a record of it: the time,
          what the system was doing, the provider&rsquo;s error code and, for QuickBooks, the
          <code> intuit_tid </code>transaction id Intuit attaches to every response. These records
          contain <strong>no financial data, passwords or tokens</strong> — anything shaped like a
          credential is removed before a record is written.
        </p>
        <p>
          They are visible to the people who manage integrations, cannot be edited, and may be
          shared with <strong>that provider&rsquo;s own support team</strong> to resolve a problem
          with that provider. That is the only sharing they are used for.
        </p>
      </Section>

      <Section title="How long we keep it">
        <p>
          Financial records are kept for as long as AHN needs them for accounting, tax and audit
          purposes, and for any period required by law in the United States and Vietnam.
        </p>
        <p>
          Disconnecting a provider deletes the stored credentials for it, as described below. It
          does not delete financial records already imported — those are AHN&rsquo;s own accounting
          history rather than the provider&rsquo;s copy of it.
        </p>
      </Section>

      <Section title="QuickBooks Online (Intuit)">
        <p>
          AHN connects its own QuickBooks company to this system through Intuit&rsquo;s OAuth 2.0
          flow. <strong>No QuickBooks credentials are entered into, or pass through, this
          application</strong> — sign-in happens on Intuit&rsquo;s own page, and what this system
          receives back is an access token, which is encrypted before it is stored.
        </p>
        <p>
          The scope requested is <code>com.intuit.quickbooks.accounting</code>, and what is read
          from it is listed above. Data from QuickBooks is used only for AHN&rsquo;s own internal
          reporting. It is not sold, not shared, and not sent to any third party.
        </p>
        <p>
          <strong>Disconnecting works from either side.</strong> From inside QuickBooks
          (Apps &rarr; My Apps &rarr; Disconnect), Intuit revokes the connection and this system
          stops receiving data. From the Integrations page in this application, disconnecting calls
          Intuit&rsquo;s token revocation endpoint <em>and</em> deletes the stored tokens here, so
          the grant is ended at both ends.
        </p>
        <p>
          AHN Financial OS is an independent application. It is not produced, endorsed or supported
          by Intuit Inc., whose handling of QuickBooks data is governed by{' '}
          <A href="https://www.intuit.com/privacy/statement/">Intuit&rsquo;s own privacy statement</A>.
        </p>
      </Section>

      <Section title="Plaid">
        <p>
          When AHN connects a bank account, that connection is made through Plaid Inc. Plaid
          collects the credentials entered in its own interface —{' '}
          <strong>those credentials are never seen by, or passed through, this application</strong>.
          Plaid&rsquo;s handling of that information is governed by its own policy:{' '}
          <A href="https://plaid.com/legal/#end-user-privacy-policy">plaid.com/legal</A>.
        </p>
        <p>
          AHN can disconnect any linked account at any time from the Integrations page, which
          deletes the stored access token.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions about this policy, or a request concerning data held about you, can be sent to{' '}
          <A href="mailto:team@asianhustlenetwork.com">team@asianhustlenetwork.com</A>.
        </p>
      </Section>

      <LegalFooter current="privacy" />
    </LegalPage>
  );
}
