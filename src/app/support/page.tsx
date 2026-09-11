import type { Metadata } from 'next';
import { A, LegalPage, Section } from '@/components/legal';

export const metadata: Metadata = {
  title: 'Support — AHN Financial OS',
  description: 'How to get help with AHN Financial OS, and what to include so a problem can be traced.',
};

const SUPPORT_EMAIL = 'team@asianhustlenetwork.com';

/**
 * Support - how to reach the people who run this system, from inside it.
 *
 * PUBLIC ON PURPOSE, like the legal pages. Intuit's review asks whether
 * customers can contact support from within the app; a reviewer checking that
 * is not signed in, and neither is somebody locked out of their own account —
 * which is one of the more common reasons to need support at all.
 *
 * `?tid=` and `?provider=` pre-fill the email. The Integrations page links here
 * from each logged error, so the one piece of information Intuit's support
 * actually looks a request up by arrives without anybody having to copy it.
 */
export default async function SupportPage(props: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  // Next 15: a Promise. Rebound under the old name so nothing below changes.
  const searchParams = await props.searchParams;
  // Only what a tid and a provider name can look like. This is echoed into a
  // mailto link, and a free-text parameter there is a way to put words in a
  // support request that the sender did not write.
  const tid = /^[A-Za-z0-9-]{1,80}$/.test(searchParams.tid ?? '') ? searchParams.tid! : null;
  const provider = /^[a-z]{2,20}$/.test(searchParams.provider ?? '') ? searchParams.provider! : null;

  const subject = tid
    ? `AHN Financial OS — ${provider ?? 'provider'} error ${tid}`
    : 'AHN Financial OS — support request';
  const body = [
    'What were you trying to do?',
    '',
    'When did it happen (date, time, time zone)?',
    '',
    ...(tid ? [`intuit_tid: ${tid}`, ''] : []),
    'What did you see? (A screenshot helps.)',
    '',
  ].join('\n');
  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  return (
    <LegalPage
      title="Support"
      updated="11 September 2026"
      lede="AHN Financial OS is built and run by AHN's own team. Support comes from the same people."
    >
      <Section title="Contact us">
        <p>
          Email <A href={mailto}>{SUPPORT_EMAIL}</A>. It reaches the team that builds and operates this
          system, not a ticket queue.
        </p>
        {tid && (
          <p style={{ marginTop: 10 }}>
            The link above already includes the QuickBooks transaction id{' '}
            <code style={{ fontSize: 13 }}>{tid}</code>, which lets us — and Intuit, if we need to
            escalate — find the exact request that failed.
          </p>
        )}
      </Section>

      <Section title="What to include">
        <ul>
          <li>What you were trying to do, and roughly when — with your time zone.</li>
          <li>
            For a QuickBooks problem, the <strong>intuit_tid</strong>. Every QuickBooks error on the
            Integrations page shows one, with a link that brings you here with it already filled
            in.
          </li>
          <li>A screenshot, if something looks wrong on a page.</li>
          <li>
            <strong>Never a password, API key or bank credential.</strong> Nobody supporting this
            system will ever ask for one.
          </li>
        </ul>
      </Section>

      <Section title="QuickBooks connection problems">
        <p>Check the Integrations page first — it usually says exactly what is wrong.</p>
        <ul>
          <li>
            <strong>Reconnect needed</strong> — the connection expired or was disconnected from
            inside QuickBooks. Reconnect it; nothing already imported is lost.
          </li>
          <li>
            <strong>Error</strong> — a temporary problem at Intuit or on the network. The next sync,
            within ten minutes, tries again on its own.
          </li>
          <li>
            A feature your QuickBooks subscription does not include (bills on Simple Start, for
            example) is skipped, not treated as a fault, and picked up automatically if the
            subscription changes.
          </li>
        </ul>
      </Section>

      <Section title="What we keep to help">
        <p>
          Every error from a connected provider is recorded with its time, what the system was
          doing, the provider&rsquo;s error code and — for QuickBooks — the intuit_tid. Those
          records contain no passwords, tokens or financial data, and they are what we use to trace
          a problem, or to share with Intuit&rsquo;s support if it needs escalating. See the{' '}
          <A href="/privacy">Privacy Policy</A>.
        </p>
      </Section>

      <p className="faint" style={{ marginTop: 40, fontSize: 12 }}>
        <A href="/privacy">Privacy Policy</A> · <A href="/eula">End-User License Agreement</A>
      </p>
    </LegalPage>
  );
}
