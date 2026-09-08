import type { Metadata } from 'next';
import { A, LegalFooter, LegalPage, Section } from '@/components/legal';

/**
 * End-User License Agreement - required by Intuit before production keys are
 * issued, alongside the privacy policy.
 *
 * PUBLIC ON PURPOSE, for the reason given in `components/legal.tsx`.
 *
 * TWO THINGS TO KNOW ABOUT THIS DOCUMENT.
 *
 * 1. It describes an INTERNAL system. AHN is both the licensor and the only
 *    licensee; there are no paying customers and no public sign-ups. Writing it
 *    as though there were would be the easy thing to do - every EULA template
 *    online assumes a product being sold - and it would be a false statement
 *    made to a reviewer whose job is to check exactly that.
 *
 * 2. It is a drafted agreement, not reviewed by a lawyer. The jurisdiction
 *    below is the one thing here that cannot be derived from the code, and it
 *    changes what this document means. See GOVERNING_LAW.
 */
export const metadata: Metadata = {
  title: 'End-User License Agreement — AHN Financial OS',
  description:
    'Terms on which AHN staff and contractors are licensed to use the AHN Financial OS internal system.',
};

const UPDATED = '8 September 2026';

/**
 * CONFIRM BEFORE RELYING ON THIS.
 *
 * Nothing in the codebase records where AHN Media LLC is incorporated, so this
 * is the one value on the page that was not verified against something. It is
 * set out as a constant rather than buried in a paragraph so that correcting it
 * is a one-line change somebody can find.
 */
const GOVERNING_LAW = 'the State of California, United States of America';

export default function EulaPage() {
  return (
    <LegalPage
      title="End-User License Agreement"
      updated={UPDATED}
      lede="This agreement governs use of AHN Financial OS, an internal financial operations system. It is not a consumer product and is not offered for sale."
    >
      <Section title="1. Who this agreement is between">
        <p>
          This End-User License Agreement (the &ldquo;Agreement&rdquo;) is between{' '}
          <strong>AHN Media LLC</strong> and <strong>AHN Vietnam Co. Ltd</strong> (together,
          &ldquo;AHN&rdquo;, &ldquo;we&rdquo; or &ldquo;us&rdquo;) and each individual granted a
          login to AHN Financial OS (the &ldquo;Software&rdquo;) — each an &ldquo;Authorised
          User&rdquo; or &ldquo;you&rdquo;.
        </p>
        <p>
          The Software is built by AHN for AHN&rsquo;s own use. It is not sold, licensed or made
          available to the public, and no fee is charged for it. Authorised Users are AHN&rsquo;s
          own employees, officers and contractors.
        </p>
      </Section>

      <Section title="2. Accepting these terms">
        <p>
          By signing in to the Software you accept this Agreement. If you do not accept it, do not
          sign in. Access is by invitation only and can be withdrawn at any time.
        </p>
      </Section>

      <Section title="3. What you are permitted to do">
        <p>
          AHN grants you a limited, personal, non-exclusive, non-transferable, revocable licence to
          access and use the Software{' '}
          <strong>solely for AHN&rsquo;s internal business purposes</strong> and solely to the
          extent your role permits.
        </p>
        <p>
          The licence lasts only while you are engaged by AHN and holds no rights beyond that. It
          grants no ownership of the Software.
        </p>
      </Section>

      <Section title="4. What you must not do">
        <ul>
          <li>
            Share your login, password or session with anybody, or allow anybody else to act under
            your account. Every action is recorded against the account that performed it.
          </li>
          <li>
            Use the Software, or anything you see in it, for any purpose other than AHN&rsquo;s
            business — including for your own account or for a third party.
          </li>
          <li>
            Copy, extract, republish or disclose AHN&rsquo;s financial data, or the personal data of
            any AHN worker, outside AHN.
          </li>
          <li>
            Attempt to bypass the access controls, obtain data your role does not permit you to see,
            or interfere with the audit trail.
          </li>
          <li>
            Copy, modify, decompile, reverse-engineer or create derivative works of the Software,
            except as applicable law expressly permits despite this restriction.
          </li>
          <li>
            Connect a financial account that does not belong to AHN, or enter another person&rsquo;s
            credentials into any connected provider.
          </li>
        </ul>
      </Section>

      <Section title="5. Your account and your obligations">
        <p>
          You are responsible for keeping your credentials confidential and for everything done
          under your account. Tell AHN immediately at{' '}
          <A href="mailto:team@asianhustlenetwork.com">team@asianhustlenetwork.com</A> if you
          believe your account has been used by somebody else.
        </p>
        <p>
          Roles are enforced by the database rather than by the interface. Being able to reach a
          page is not permission to use what is on it; use only what your role is intended to cover.
        </p>
      </Section>

      <Section title="6. Payments and disbursement">
        <p>
          The Software can instruct payments to AHN&rsquo;s own staff and contractors through VEEM.
          This carries obligations that the rest of this Agreement does not.
        </p>
        <ul>
          <li>
            <strong>No payment may be prepared and approved by the same person.</strong> This is
            enforced by the database and must not be circumvented by sharing accounts.
          </li>
          <li>
            Check the recipient, the amount and the currency before approving. An approval is a
            confirmation that you have checked them.
          </li>
          <li>
            A sent payment cannot be recalled by the Software. Recovering it depends entirely on
            VEEM and on the recipient.
          </li>
          <li>
            Payments may only be made to AHN workers for work done for AHN. Instructing any other
            payment is a breach of this Agreement.
          </li>
        </ul>
        <p>
          The Software is a disbursement tool. It is{' '}
          <strong>not a payroll provider</strong>: it does not calculate, withhold or remit tax, and
          it does not produce statutory payroll filings in any country. Meeting those obligations
          remains AHN&rsquo;s responsibility, handled outside this system.
        </p>
      </Section>

      <Section title="7. Third-party services">
        <p>
          The Software connects to services operated by other companies — Intuit (QuickBooks
          Online), Plaid, Stripe, VEEM, Finverse and VietinBank. Your use of the Software is also
          subject to their terms, and AHN does not control them.
        </p>
        <p>
          <strong>QuickBooks Online.</strong> QuickBooks is a product of Intuit Inc. AHN Financial
          OS is an independent application built by AHN for its own use. It is{' '}
          <strong>not produced, endorsed, certified or supported by Intuit</strong>, and
          &ldquo;Intuit&rdquo; and &ldquo;QuickBooks&rdquo; are trademarks of Intuit Inc. used here
          only to identify the service being connected. Connecting a QuickBooks company to the
          Software is also governed by your agreement with Intuit, and access can be revoked at any
          time from within QuickBooks or from the Software&rsquo;s Integrations page.
        </p>
        <p>
          <strong>Bank credentials are never entered into this Software.</strong> Where a bank
          connection is made, it is made on the provider&rsquo;s own page.
        </p>
      </Section>

      <Section title="8. Data and privacy">
        <p>
          What the Software reads, stores, encrypts and retains is described in the{' '}
          <A href="/privacy">Privacy Policy</A>, which forms part of this Agreement. In summary: it
          holds AHN&rsquo;s own financial records and information about AHN&rsquo;s own workers, it
          is not sold or shared, and it is not used to make decisions about anybody outside AHN.
        </p>
        <p>
          All financial data, records and reports in the Software are AHN&rsquo;s confidential
          information. Your obligation to keep them confidential continues after your engagement
          ends.
        </p>
      </Section>

      <Section title="9. Ownership">
        <p>
          The Software, its source code and its design remain the property of AHN. Nothing in this
          Agreement transfers any intellectual property to you. Trademarks of third parties named in
          this Agreement remain the property of their owners.
        </p>
      </Section>

      <Section title="10. The figures are not advice">
        <p>
          The Software calculates cash position, burn rate, runway, break-even, budget variance and
          profitability from data supplied by connected providers and by AHN&rsquo;s own staff.
          These figures are{' '}
          <strong>management information, not accounting, tax, investment or legal advice</strong>,
          and they are not a substitute for AHN&rsquo;s accounting records or its accountants.
        </p>
        <p>
          Figures can be wrong because a provider was unreachable, a connection had expired, an
          exchange rate was stale, or something was entered incorrectly. Do not rely on a figure for
          a decision of consequence without checking it against the underlying records.
        </p>
      </Section>

      <Section title="11. Availability">
        <p>
          The Software is provided as an internal tool with no service-level commitment. It may be
          unavailable, changed or withdrawn at any time without notice, and connected providers may
          themselves be unavailable.
        </p>
      </Section>

      <Section title="12. No warranty">
        <p>
          To the fullest extent permitted by law, the Software is provided{' '}
          <strong>&ldquo;as is&rdquo; and &ldquo;as available&rdquo;</strong>, without warranty of
          any kind, whether express, implied or statutory, including any implied warranty of
          merchantability, fitness for a particular purpose, accuracy or non-infringement.
        </p>
      </Section>

      <Section title="13. Limitation of liability">
        <p>
          To the fullest extent permitted by law, AHN shall not be liable to any Authorised User for
          any indirect, incidental, special, consequential or punitive damages, or for any loss of
          profit, revenue, data or goodwill, arising out of or in connection with the Software or
          this Agreement, whether in contract, tort or otherwise, even if AHN has been advised of
          the possibility of such damages.
        </p>
        <p>
          Nothing in this Agreement excludes or limits liability that cannot lawfully be excluded or
          limited, including liability for fraud, for fraudulent misrepresentation, or for death or
          personal injury caused by negligence.
        </p>
      </Section>

      <Section title="14. Ending your access">
        <p>
          This Agreement and your licence end automatically when your engagement with AHN ends, and
          may be terminated or suspended by AHN at any time, with or without notice, including
          immediately on any breach of this Agreement.
        </p>
        <p>
          On termination you must stop using the Software and destroy any AHN financial data in your
          possession. Sections 4, 8, 9, 12, 13 and 15 survive termination.
        </p>
      </Section>

      <Section title="15. Governing law">
        <p>
          This Agreement is governed by the laws of {GOVERNING_LAW}, without regard to its conflict
          of laws rules. The courts of that jurisdiction have exclusive jurisdiction over any
          dispute arising out of it, save that AHN may seek injunctive relief in any competent
          court.
        </p>
      </Section>

      <Section title="16. Changes to this agreement">
        <p>
          AHN may update this Agreement. The date at the top of this page changes when it does, and
          continuing to use the Software after a change means you accept the updated Agreement. A
          change that materially affects Authorised Users will be notified to them.
        </p>
      </Section>

      <Section title="17. General">
        <p>
          If any provision of this Agreement is held unenforceable, the rest remains in force. A
          failure to enforce a provision is not a waiver of it. This Agreement, together with the
          Privacy Policy, is the entire agreement between AHN and Authorised Users regarding the
          Software.
        </p>
      </Section>

      <Section title="18. Contact">
        <p>
          Questions about this Agreement can be sent to{' '}
          <A href="mailto:team@asianhustlenetwork.com">team@asianhustlenetwork.com</A>.
        </p>
      </Section>

      <LegalFooter current="eula" />
    </LegalPage>
  );
}
