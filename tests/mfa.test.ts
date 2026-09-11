import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { assuranceStep, mfaPathFor } from '@/lib/auth';
import { totp } from './helpers/totp';

/**
 * Mandatory two-factor sign-in — the routing half. The boundary half, what a
 * one-factor token can read, is `mfa.integration.test.ts` against the database.
 */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('assuranceStep', () => {
  it('lets a two-factor session through', () => {
    expect(assuranceStep('aal2', 'aal2')).toBe('ok');
  });

  it('asks for the code when an authenticator exists but was not used', () => {
    expect(assuranceStep('aal1', 'aal2')).toBe('challenge');
  });

  it('sends somebody with no authenticator to set one up — there is no opting out', () => {
    expect(assuranceStep('aal1', 'aal1')).toBe('enroll');
  });

  it('treats anything unrecognised as unfinished, never as fine', () => {
    expect(assuranceStep(null, null)).toBe('enroll');
    expect(assuranceStep('aal3' as string, null)).toBe('enroll');
  });
});

describe('mfaPathFor', () => {
  it('routes each unfinished step to its page', () => {
    expect(mfaPathFor('enroll')).toBe('/mfa/setup');
    expect(mfaPathFor('challenge')).toBe('/mfa');
  });

  it('carries where they were going', () => {
    expect(mfaPathFor('challenge', '/payroll')).toBe('/mfa?next=%2Fpayroll');
  });

  it('has nothing to say to a finished or absent session', () => {
    expect(mfaPathFor('ok')).toBeNull();
    expect(mfaPathFor('none')).toBeNull();
  });
});

describe('the test TOTP generator matches RFC 6238', () => {
  it('produces the published test vector', () => {
    // RFC 6238 appendix B, SHA-1, T = 59s → 94287082; six digits → 287082.
    // The key is ASCII "12345678901234567890", base32-encoded.
    expect(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082');
  });
});

describe('nothing opens a one-factor way in', () => {
  const auth = read('src/lib/auth.ts');

  it('getSession returns nothing below two factors', () => {
    const body = auth.slice(auth.indexOf('export const getSession'));
    expect(body.slice(0, 800)).toMatch(/getAssurance\(\)\)\s*!==\s*'ok'\)\s*return null/);
  });

  it('API routes refuse an unfinished session with a reason the client can route on', () => {
    const api = auth.slice(auth.indexOf('export async function requireApiSession'));
    expect(api).toContain("Two-factor verification is required.");
  });

  it('the app layout routes a half-signed-in person to MFA, not to /login', () => {
    // Found the hard way: the layout used to redirect every null session to
    // /login, so a one-factor session bounced through the password form again.
    expect(read('src/app/(app)/layout.tsx')).toMatch(/mfaPathFor\(await getAssurance\(\)\)/);
  });

  it('setup refuses somebody who already has an authenticator', () => {
    // Otherwise a stolen password could enrol the thief's phone.
    expect(read('src/app/mfa/setup/page.tsx')).toMatch(/step === 'challenge'\) redirect/);
  });

  it('the MFA pages are outside the signed-in route group', () => {
    expect(fs.existsSync(path.join(process.cwd(), 'src/app/mfa/page.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), 'src/app/(app)/mfa'))).toBe(false);
  });

  it('there is no skip', () => {
    const forms = read('src/components/MfaForms.tsx');
    expect(forms).not.toMatch(/skip|later|not now/i);
  });

  it('the reset tool demands --confirm and writes an audit record', () => {
    const reset = read('scripts/mfa-reset.mjs');
    expect(reset).toContain("flag !== '--confirm'");
    expect(reset).toContain("from('audit_logs').insert");
    // A sign-out call that could not work, with its error swallowed, was
    // removed; it must not come back looking like protection.
    expect(reset).not.toMatch(/signOut\?\.\(/);
  });
});
