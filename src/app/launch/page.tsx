import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { safeNextPath } from '@/lib/security';

export const dynamic = 'force-dynamic';

/**
 * Intuit's Launch URL - where QuickBooks sends a user who clicks this app from
 * inside their company file (Apps to My Apps to the app tile).
 *
 * PUBLIC ON PURPOSE. Whoever clicks that tile arrives with no session here,
 * because their QuickBooks session means nothing to this application. If this
 * page sat inside `(app)` they would be bounced to `/login` with the reason
 * unexplained; worse, a route that answered 401 would look broken to a reviewer
 * who is checking that the Launch URL resolves.
 *
 * SO IT IS A SIGNPOST, NOT A DOOR. Intuit's own guidance for an app that is not
 * listed on their App Store is that the Launch URL should be the app's sign-in
 * page. That is exactly what this resolves to when nobody is signed in — and
 * for somebody who is, skipping the sign-in screen is the whole point of having
 * clicked the tile.
 *
 * THERE IS NO INTUIT SSO HERE, deliberately. Signing somebody in on the
 * strength of "Intuit sent them" would mean an Intuit account was enough to
 * reach AHN's cash position. Access to this system is by named invitation and
 * stays that way; arriving from QuickBooks changes where you land, never
 * whether you are let in.
 *
 * Intuit may append `realmId` to this URL. It is not read: it is an unsigned
 * query parameter and nothing here should act on one.
 */
export default async function LaunchPage(props: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  // Next 15: a Promise. Rebound under the old name so nothing below changes.
  const searchParams = await props.searchParams;
  // Where the tile should land somebody: the page about the connection they
  // just came from. `?next=` is honoured so the same URL can serve a deep link,
  // and it goes through `safeNextPath` so it cannot be turned into an open
  // redirect by anybody who can hand a colleague a URL.
  const destination = safeNextPath(searchParams.next, '/integrations');

  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(destination)}`);

  redirect(destination);
}
