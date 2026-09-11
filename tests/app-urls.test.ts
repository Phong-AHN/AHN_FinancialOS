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
  'src/app/support/page.tsx',
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

describe('QuickBooks tokens come only from the in-app OAuth flow', () => {
  /**
   * Intuit's review asks whether the app relies on the OAuth Playground or
   * another offline tool for its tokens. The answer is no, and it is the answer
   * that matters: a token pasted in from the Playground belongs to whoever
   * pasted it, cannot be reauthorised by the customer, and dies silently after
   * 100 days with no flow to replace it.
   *
   * The easy way for that answer to become false is a "temporary" env var —
   * `QBO_REFRESH_TOKEN=...` to get a demo working — which is exactly how the
   * Playground ends up in production. These tests fail the day that happens.
   */
  const walk = (dir: string): string[] =>
    fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) return walk(rel);
      return /\.(ts|tsx|mjs|js)$/.test(e.name) ? [rel] : [];
    });
  const sources = [...walk('src'), ...walk('scripts'), ...walk('worker')];

  it('reads no QuickBooks token from the environment', () => {
    const offenders = sources.filter((f) => /process\.env\.QBO_[A-Z_]*TOKEN/.test(read(f)));
    expect(offenders, 'a QuickBooks token is being loaded from an env var').toEqual([]);
    expect(read('.env.example')).not.toMatch(/^QBO_[A-Z_]*TOKEN\s*=/m);
  });

  it('stores a new QuickBooks grant in exactly one place: the OAuth callback', () => {
    // A CALL whose options object names quickbooks — not merely a file that
    // mentions both. `sync.ts` defines the function and separately says
    // `provider: 'quickbooks'` in a result object, and the loose version of
    // this check counted that as a second writer.
    const call = /saveIntegrationTokens\(\s*\w+\s*,\s*\{[^}]*provider:\s*'quickbooks'/;
    const writers = sources.filter((f) => call.test(read(f)));
    expect(writers).toEqual(['src/app/api/integrations/quickbooks/callback/route.ts']);
  });

  it('gets that grant by exchanging an authorisation code, after checking state', () => {
    const callback = read('src/app/api/integrations/quickbooks/callback/route.ts');
    const stateCheck = callback.indexOf('safeEqual(state, expected)');
    const exchange = callback.indexOf('exchangeCodeForTokens(code)');
    expect(stateCheck).toBeGreaterThan(-1);
    expect(exchange, 'the code is exchanged before the CSRF check').toBeGreaterThan(stateCheck);
  });

  it('only ever refreshes with the refresh token that flow issued', () => {
    // The one other place tokens are written is the rotation inside
    // getAccessToken — which reads the stored, encrypted refresh token and
    // nothing else.
    const connector = read('src/lib/connectors/quickbooks.ts');
    expect(connector).toContain('refreshTokens(decryptSecret(integration.refresh_token_enc))');
    expect(connector).toContain("grant_type: 'authorization_code'");
    expect(connector).toContain("grant_type: 'refresh_token'");
  });
});

describe('the Intuit API categories declared on the review form', () => {
  /**
   * The form asks which API categories the app uses, and the answer given is
   * "Accounting API" alone. Payroll and Payments are restricted categories with
   * a much stricter review; declaring them without using them invites scrutiny,
   * and USING them without declaring them is a false statement to Intuit.
   *
   * AHN does pay people — through VEEM, not through QuickBooks Payroll — and it
   * does take payments — through Stripe, not QuickBooks Payments. This keeps it
   * that way until somebody deliberately changes the answer too.
   */
  it('requests the accounting scope and nothing else', () => {
    const connector = read('src/lib/connectors/quickbooks.ts');
    const scopes = [...connector.matchAll(/com\.intuit\.quickbooks\.[a-z.]+/g)].map((m) => m[0]);
    expect([...new Set(scopes)]).toEqual(['com.intuit.quickbooks.accounting']);
  });
});

describe('troubleshooting answers on the Intuit form stay true', () => {
  it('every classified Intuit response carries its intuit_tid', () => {
    // Intuit's review asks whether the app captures intuit_tid. One call site
    // that forgets it is one class of failure nobody can look up.
    const connector = read('src/lib/connectors/quickbooks.ts');
    const calls = [...connector.matchAll(/classifyIntuitFailure\(([^;]*)\)/g)].map((m) => m[1]!);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    const without = calls.filter((c) => !/intuit_tid|Tid/.test(c));
    expect(without, 'a classified response dropped the intuit_tid').toEqual([]);
  });

  it('every failure path in the sync writes to the error log', () => {
    const sync = read('src/lib/sync.ts');

    // The shared path: markFailed logs before it does anything else.
    const markFailed = sync.slice(sync.indexOf('async function markFailed('));
    expect(markFailed.slice(0, 1200)).toContain('recordIntegrationError(');

    // The providers that record their own failure, one update each. Matched on
    // the real statement, not on the words — a comment mentioning
    // `status: 'error'` is not a failure path.
    const own = [...sync.matchAll(/\.update\(\{ status: 'error', last_error: result\.error \}\)/g)].map(
      (m) => m.index!,
    );
    expect(own.length, 'the per-provider failure updates were not found').toBe(3);
    for (const at of own) {
      expect(sync.slice(at, at + 400), `a failure at offset ${at} is not logged`).toContain(
        'recordIntegrationError(',
      );
    }
  });

  it('support is reachable from every signed-in page and from sign-in', () => {
    expect(read('src/components/Sidebar.tsx')).toContain('href="/support"');
    expect(read('src/app/login/page.tsx')).toContain('href="/support"');
  });

  it('the support page only echoes a tid that looks like a tid', () => {
    // It is put into a mailto link. A free-text parameter there is a way to
    // put words in a support request the sender did not write.
    expect(read('src/app/support/page.tsx')).toMatch(/\^\[A-Za-z0-9-\]\{1,80\}\$/);
  });

  it('the privacy policy describes the error log, including that it may leave', () => {
    const policy = read('src/app/privacy/page.tsx');
    expect(policy).toContain('Error records');
    expect(policy).toContain('intuit_tid');
    expect(policy).toMatch(/no financial data, passwords or tokens/);
    expect(policy).toMatch(/provider&rsquo;s own support team/);
  });

  it('nobody can edit or delete an error record', () => {
    const migration = read('supabase/migrations/0039_integration_errors.sql');
    expect(migration).not.toMatch(/for update/i);
    expect(migration).not.toMatch(/for delete/i);
    expect(migration).toMatch(/enable row level security/i);
  });
});

describe('the privacy policy names everywhere data is sent', () => {
  /**
   * Alerts went through Slack, Resend and Twilio from week one, carrying
   * amounts and counterparties, while the policy said "we do not share it with
   * third parties" and named none of them (decision 109). This fails the day a
   * new outbound service is added without the policy saying so.
   */
  const KNOWN: Record<string, string> = {
    'slack.com': 'Slack',
    'api.resend.com': 'Resend',
    'api.twilio.com': 'Twilio',
  };

  it('every host an alert is delivered to is named in the policy', () => {
    const channels = read('src/lib/alerts/channels.ts');
    const policy = read('src/app/privacy/page.tsx');
    const hosts = [...new Set([...channels.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]!))];

    const unlisted = hosts.filter((h) => !KNOWN[h]);
    expect(unlisted, 'an alert channel this test and the policy do not know about').toEqual([]);

    const unnamed = hosts.filter((h) => !policy.includes(`<strong>${KNOWN[h]}</strong>`));
    expect(unnamed, 'an alert channel the privacy policy does not name').toEqual([]);
  });

  it('says two-factor sign-in is mandatory, which migration 0040 makes true', () => {
    const policy = read('src/app/privacy/page.tsx');
    expect(policy).toMatch(/Two-factor sign-in is mandatory/);
    expect(read('supabase/migrations/0040_require_mfa.sql')).toContain('p_require_mfa');
  });
});

describe('one QuickBooks company at a time', () => {
  /**
   * QuickBooks numbers every company's records from 1 and this system's keys do
   * not name the company, so a second company's `Purchase:123` would be skipped
   * as a duplicate of the first's. The callback refuses while another company is
   * on record, and the purge script is the only way to clear one.
   */
  const callback = read('src/app/api/integrations/quickbooks/callback/route.ts');

  it('refuses a second company BEFORE exchanging the code', () => {
    const guard = callback.indexOf(".neq('external_id', realmId)");
    const exchange = callback.indexOf('exchangeCodeForTokens(code)');
    expect(guard, 'the second-company guard is missing').toBeGreaterThan(-1);
    // After the exchange would leave Intuit holding a grant nothing here can revoke.
    expect(exchange).toBeGreaterThan(guard);
  });

  it('the purge refuses when two companies are on record, or one is still connected', () => {
    const purge = read('scripts/purge-quickbooks-sandbox.mjs');
    expect(purge).toMatch(/companies\.length > 1/);
    expect(purge).toMatch(/company\.refresh_token_enc/);
    expect(purge).toContain("args.includes('--confirm')");
  });
});
