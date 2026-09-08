import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The URLs registered with Intuit, and the promises the legal pages make.
 *
 * Intuit's production app settings take five values that live in this
 * repository: a Launch URL, a Disconnect URL, a Connect/Reconnect URL, an EULA
 * link and a privacy policy link. A reviewer opens all five, SIGNED OUT. A
 * route that answers 401, or a page that quietly moved inside the authenticated
 * route group, fails the review without anybody here seeing an error.
 *
 * Two of these tests are not about Intuit at all. They guard properties that
 * were bugs in this codebase within the last day:
 *
 *   - `/disconnect` must not write. It is an unauthenticated, guessable URL.
 *   - `/privacy` promised token revocation months before any revoke call
 *     existed. The claim is now true; this keeps it true.
 */
const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

/** The pages Intuit and Plaid reach while signed out. */
const PUBLIC_PAGES = [
  'src/app/privacy/page.tsx',
  'src/app/eula/page.tsx',
  'src/app/launch/page.tsx',
  'src/app/disconnect/page.tsx',
];

describe('the URLs registered with Intuit exist', () => {
  it.each(PUBLIC_PAGES)('%s is a real page', (page) => {
    expect(exists(page), `${page} is registered with Intuit and must exist`).toBe(true);
  });

  it('the Connect/Reconnect URL is a real route', () => {
    expect(exists('src/app/api/integrations/quickbooks/connect/route.ts')).toBe(true);
  });

  it('none of them sits inside the authenticated route group', () => {
    // `(app)/layout.tsx` calls `requireSession()`. A public page that drifts in
    // there starts redirecting a signed-out reviewer to /login.
    const inside = PUBLIC_PAGES.filter((p) => p.includes('(app)'));
    expect(inside, 'a public page moved inside (app)').toEqual([]);
  });

  it('none of them requires a session to render', () => {
    const guarded = PUBLIC_PAGES.filter((p) =>
      /requireSession|requireOwner|requireCapability|requireApiSession/.test(read(p)),
    );
    expect(guarded, 'a page Intuit opens signed-out demands a session').toEqual([]);
  });
});

describe('the Disconnect URL is safe to load anonymously', () => {
  /**
   * Intuit signs nothing when it redirects somebody here, and the URL is
   * written down in the app settings and in this repo. If loading it destroyed
   * the connection, then a crawler, a link preview or anybody who has seen the
   * URL could sever AHN's accounting integration with a GET.
   */
  it('performs no database write', () => {
    const source = read('src/app/disconnect/page.tsx');
    const writes = ['.update(', '.delete(', '.insert(', '.upsert(', '.rpc('];
    const found = writes.filter((w) => source.includes(w));
    expect(found, 'the disconnect landing page writes to the database').toEqual([]);
  });

  it('never calls the revoke endpoint', () => {
    expect(read('src/app/disconnect/page.tsx')).not.toContain('revokeTokens');
  });

  it('shows nothing about AHN to somebody who is not signed in', () => {
    // The integration count is read inside a `mayManage` branch. Without that,
    // an anonymous visitor learns whether AHN has QuickBooks connected.
    const source = read('src/app/disconnect/page.tsx');
    const guard = source.indexOf('mayManage');
    const query = source.indexOf("from('integrations')");
    expect(guard).toBeGreaterThan(-1);
    expect(query, 'the integrations query is not behind the permission check').toBeGreaterThan(guard);
  });
});

describe('the privacy policy does not promise what the code will not do', () => {
  const policy = read('src/app/privacy/page.tsx');
  const route = read('src/app/api/integrations/[id]/route.ts');

  it('claims revocation, and a revoke call exists', () => {
    expect(policy).toMatch(/revocation endpoint|revokes the/i);
    expect(read('src/lib/connectors/quickbooks.ts')).toContain('export async function revokeTokens');
    expect(route, 'the disconnect route never calls revokeTokens').toContain('revokeTokens(');
  });

  it('revokes at the provider BEFORE deleting our copy of the token', () => {
    // Order matters. Clearing our token first and then failing to revoke leaves
    // the grant live at Intuit with nothing left here able to retry it.
    const revoke = route.indexOf('revokeTokens(');
    const clear = route.indexOf('refresh_token_enc: null');
    expect(revoke).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(-1);
    expect(clear, 'tokens are cleared before the revoke is confirmed').toBeGreaterThan(revoke);
  });

  it('says disconnecting keeps imported records, which is what the route does', () => {
    expect(policy).toMatch(/does not delete financial records/i);
    // The route touches `integrations` only. A delete against transactions here
    // would make that sentence false.
    expect(route).not.toContain("from('transactions')");
  });
});

describe('the legal pages reach each other', () => {
  it('the privacy policy links the EULA and the EULA links the policy', () => {
    // A reviewer lands on whichever URL was entered in the app settings and
    // must be able to find the other.
    expect(read('src/components/legal.tsx')).toContain('/eula');
    expect(read('src/components/legal.tsx')).toContain('/privacy');
    expect(read('src/app/privacy/page.tsx')).toContain('LegalFooter');
    expect(read('src/app/eula/page.tsx')).toContain('LegalFooter');
  });

  it('both are reachable from the sign-in page, the only page every visitor sees', () => {
    const login = read('src/app/login/page.tsx');
    expect(login).toContain('/privacy');
    expect(login).toContain('/eula');
  });
});

describe('the Launch URL', () => {
  const launch = read('src/app/launch/page.tsx');

  it('launders its redirect target', () => {
    // `/launch?next=//evil.com` must not become a landing page an attacker
    // chose. `safeNextPath` is the existing guard; this checks it is used.
    expect(launch).toContain('safeNextPath');
  });

  it('does not sign anybody in on Intuit’s say-so', () => {
    // Arriving from QuickBooks changes where you land, never whether you are
    // let in. An Intuit account is not an AHN account.
    expect(launch).not.toMatch(/signIn|setSession|createUser|auth\.admin/);
  });
});

describe('every URL pasted into Intuit is written down', () => {
  it('DEPLOYMENT.md lists all five', () => {
    const deployment = read('docs/DEPLOYMENT.md');
    for (const url of [
      '/launch',
      '/disconnect',
      '/api/integrations/quickbooks/connect',
      '/eula',
      '/privacy',
    ]) {
      expect(deployment, `${url} is not documented for whoever fills in the Intuit form`).toContain(
        url,
      );
    }
  });
});

describe('revokeTokens', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = (status: number, body = '') =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status })),
    );

  it('treats 200 as done', async () => {
    stub(200);
    const { revokeTokens } = await import('@/lib/connectors/quickbooks');
    await expect(revokeTokens('a-refresh-token')).resolves.toBeUndefined();
  });

  it('treats 400 as already gone rather than a failure', async () => {
    // Intuit answers 400 for a token it does not recognise — revoked already,
    // or expired after 101 days unused. The grant is gone either way, which is
    // the state the caller wanted. Throwing here would leave a row that could
    // never be disconnected.
    stub(400, 'invalid_token');
    const { revokeTokens } = await import('@/lib/connectors/quickbooks');
    await expect(revokeTokens('stale')).resolves.toBeUndefined();
  });

  it('throws on anything else, so the token is kept and can be retried', async () => {
    stub(503, 'service unavailable');
    const { revokeTokens } = await import('@/lib/connectors/quickbooks');
    await expect(revokeTokens('x')).rejects.toThrow(/503/);
  });

  it('posts to Intuit’s documented revoke endpoint with JSON', async () => {
    const spy = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const { revokeTokens } = await import('@/lib/connectors/quickbooks');
    await revokeTokens('the-refresh-token');

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://developer.api.intuit.com/v2/oauth2/tokens/revoke');
    expect(init.method).toBe('POST');
    // The refresh token, not the access token: revoking it kills the whole
    // grant, where revoking an access token leaves the refresh token able to
    // mint another one.
    expect(JSON.parse(String(init.body))).toEqual({ token: 'the-refresh-token' });
  });
});
