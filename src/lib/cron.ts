import { safeEqual } from '@/lib/crypto';

/**
 * Guard for /api/cron/*.
 *
 * These routes move real money data and send real alerts, so they must not be
 * open to anyone who finds the URL. Vercel Cron sends `Authorization: Bearer
 * <CRON_SECRET>` automatically; a manual trigger can pass the same header.
 *
 * With no CRON_SECRET set the routes refuse to run rather than defaulting to
 * open - an unauthenticated endpoint that hammers the QuickBooks API and pages
 * the CEO is not an acceptable default.
 */
export function authorizeCron(request: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json(
      { error: 'CRON_SECRET is not set, so scheduled routes are disabled.' },
      { status: 503 },
    );
  }

  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token || !safeEqual(token, secret)) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  return null;
}
