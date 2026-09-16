import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { PageHeader } from '@/components/ui';
import { SecuritySettings } from '@/components/SecuritySettings';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Your sign-in — My Cash Pilot' };

/**
 * A person's own sign-in: the password, and which phone holds the second
 * factor.
 *
 * Open to every role, because every account has both and neither is anybody
 * else's business. Resetting SOMEBODY ELSE's authenticator — the lost-phone
 * case — lives on the access page, behind `manage_people`.
 */
export default async function SecurityPage() {
  const session = await requireSession();

  return (
    <>
      <PageHeader
        title="Your sign-in"
        subtitle="Change your password, or move your authenticator to a new phone."
      />
      <SecuritySettings email={session.email} />
    </>
  );
}
