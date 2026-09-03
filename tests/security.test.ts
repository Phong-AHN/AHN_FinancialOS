import { describe, expect, it } from 'vitest';
import {
  callerKey,
  constantTimeEqual,
  crossOriginRefusal,
  rateLimitRefusal,
  safeNextPath,
} from '@/lib/security';

describe('safeNextPath', () => {
  it('allows an ordinary in-app path', () => {
    expect(safeNextPath('/transactions')).toBe('/transactions');
    expect(safeNextPath('/projects/abc?tab=costs')).toBe('/projects/abc?tab=costs');
  });

  it('refuses the protocol-relative form that made this a real bug', () => {
    // `?next=//evil.com` becomes `https://ourapp.com//evil.com`, which every
    // browser reads as protocol-relative and follows off-site — after the
    // victim has already authenticated against the real application.
    expect(safeNextPath('//evil.com')).toBe('/');
    expect(safeNextPath('//evil.com/login')).toBe('/');
  });

  it('refuses an absolute URL', () => {
    for (const value of [
      'https://evil.com',
      'http://evil.com',
      'javascript:alert(1)',
      'data:text/html,<script>',
    ]) {
      expect(safeNextPath(value), value).toBe('/');
    }
  });

  it('refuses backslash variants some browsers normalise to slashes', () => {
    expect(safeNextPath('/\\evil.com')).toBe('/');
    expect(safeNextPath('/\\/evil.com')).toBe('/');
    expect(safeNextPath('/path\\to')).toBe('/');
  });

  it('refuses control characters, which is how one redirect becomes two responses', () => {
    expect(safeNextPath('/ok\nLocation: https://evil.com')).toBe('/');
    expect(safeNextPath('/ok\r\nSet-Cookie: a=b')).toBe('/');
    expect(safeNextPath(`/ok${String.fromCharCode(0)}`)).toBe('/');
    expect(safeNextPath(`/ok${String.fromCharCode(127)}`)).toBe('/');
  });

  it('falls back for empty input', () => {
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
    expect(safeNextPath('')).toBe('/');
    expect(safeNextPath('   ')).toBe('/');
  });

  it('honours a caller-supplied fallback', () => {
    expect(safeNextPath('https://evil.com', '/integrations')).toBe('/integrations');
  });
});

function post(headers: Record<string, string>): Request {
  return new Request('https://ahn.example/api/projects', { method: 'POST', headers });
}

describe('crossOriginRefusal', () => {
  it('never blocks a read', () => {
    const get = new Request('https://ahn.example/api/projects', {
      method: 'GET',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(crossOriginRefusal(get)).toBeNull();
  });

  it('allows a same-origin write', () => {
    expect(crossOriginRefusal(post({ 'sec-fetch-site': 'same-origin' }))).toBeNull();
    expect(crossOriginRefusal(post({ origin: 'https://ahn.example' }))).toBeNull();
    expect(crossOriginRefusal(post({ referer: 'https://ahn.example/projects' }))).toBeNull();
  });

  it('refuses a write a form on another site caused', async () => {
    // The session is a cookie, so without this the browser would attach the
    // reader's credentials to a POST they never intended — and every route
    // behind this check moves money data.
    const refused = crossOriginRefusal(post({ origin: 'https://evil.com' }));
    expect(refused).not.toBeNull();
    expect(refused!.status).toBe(403);
  });

  it('trusts Sec-Fetch-Site over a spoofable Origin', () => {
    expect(crossOriginRefusal(post({ 'sec-fetch-site': 'cross-site' }))).not.toBeNull();
    // A browser reporting same-origin settles it even without an Origin header.
    expect(crossOriginRefusal(post({ 'sec-fetch-site': 'same-origin' }))).toBeNull();
  });

  it('refuses an Origin that cannot be parsed', () => {
    expect(crossOriginRefusal(post({ origin: 'not a url' }))).not.toBeNull();
  });

  it('allows a request that is plainly not from a browser', () => {
    // No Origin, no Referer, no Sec-Fetch-Site: server-to-server, or the test
    // harness. A browser form post always carries at least one of them.
    expect(crossOriginRefusal(post({}))).toBeNull();
  });
});

describe('rateLimitRefusal', () => {
  it('allows up to the limit and refuses past it', () => {
    const key = `test-${Math.random()}`;
    const config = { limit: 3, windowMs: 60_000 };

    expect(rateLimitRefusal(key, config)).toBeNull();
    expect(rateLimitRefusal(key, config)).toBeNull();
    expect(rateLimitRefusal(key, config)).toBeNull();

    const refused = rateLimitRefusal(key, config);
    expect(refused).not.toBeNull();
    expect(refused!.status).toBe(429);
    expect(refused!.headers.get('retry-after')).toBeTruthy();
  });

  it('keeps separate callers separate', () => {
    const config = { limit: 1, windowMs: 60_000 };
    const a = `a-${Math.random()}`;
    const b = `b-${Math.random()}`;

    expect(rateLimitRefusal(a, config)).toBeNull();
    expect(rateLimitRefusal(a, config)).not.toBeNull();
    // One caller exhausting their budget must not lock everybody else out.
    expect(rateLimitRefusal(b, config)).toBeNull();
  });

  it('forgets a window that has passed', async () => {
    const key = `expiry-${Math.random()}`;
    const config = { limit: 1, windowMs: 20 };

    expect(rateLimitRefusal(key, config)).toBeNull();
    expect(rateLimitRefusal(key, config)).not.toBeNull();

    await new Promise((r) => setTimeout(r, 30));
    expect(rateLimitRefusal(key, config)).toBeNull();
  });
});

describe('callerKey', () => {
  it('takes the first hop of x-forwarded-for', () => {
    // The proxy appends; the client is first. Taking the last would key every
    // request to our own load balancer and limit the whole company as one.
    const request = new Request('https://ahn.example/api/x', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 10.0.0.2' },
    });
    expect(callerKey(request, 'sync')).toBe('sync:203.0.113.9');
  });

  it('falls back rather than throwing when there is no address', () => {
    const request = new Request('https://ahn.example/api/x', { method: 'POST' });
    expect(callerKey(request, 'sync')).toBe('sync:unknown');
  });
});

describe('constantTimeEqual', () => {
  it('matches identical secrets and rejects different ones', () => {
    expect(constantTimeEqual('s3cret-value', 's3cret-value')).toBe(true);
    expect(constantTimeEqual('s3cret-value', 's3cret-valuf')).toBe(false);
  });

  it('rejects a different length without leaking that it was the length', () => {
    // The previous implementation returned early on a length mismatch, which
    // tells an attacker how long the secret is — one of the two things they
    // need. Hashing both sides first makes every comparison the same width.
    expect(constantTimeEqual('short', 'a-much-longer-secret')).toBe(false);
    expect(constantTimeEqual('', 'x')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});
