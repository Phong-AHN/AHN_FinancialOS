import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { magicLinkSent, signInMessage } from '@/lib/auth-messages';

/**
 * The sentences somebody reads at the worst moment of their day with this
 * product: locked out, holding a link that will not work, on a phone.
 *
 * Every raw string below is one Supabase actually returns.
 */

describe('a password that does not work', () => {
  const wrong = signInMessage('Invalid login credentials');

  it('says what to try next, not just that it failed', () => {
    expect(wrong?.text).toMatch(/do not match/i);
    expect(wrong?.text).toMatch(/capitals|sign-in link/i);
    expect(wrong?.retryable).toBe(true);
  });

  it('reads identically for an address with no account', () => {
    // Otherwise the form answers "does this person work here?" for anybody
    // who cares to ask, one address at a time.
    expect(signInMessage('Signups not allowed for otp')?.text).toBe(wrong?.text);
    expect(signInMessage('User not found')?.text).toBe(wrong?.text);
  });

  it('never names the field that was wrong', () => {
    expect(wrong?.text.toLowerCase()).not.toMatch(/\bpassword is\b|incorrect password|no account|unknown email/);
  });
});

describe('a link that will not open', () => {
  it.each([
    'Token has expired or is invalid',
    'Email link is invalid or has expired',
    'otp_expired',
  ])('%s becomes one sentence with a way out', (raw) => {
    const message = signInMessage(raw);
    expect(message?.text).toMatch(/expired or has already been used/i);
    expect(message?.text).toMatch(/ask for a new one/i);
    expect(message?.retryable).toBe(true);
  });

  it('names the real cause when a link is opened in another browser', () => {
    const message = signInMessage('invalid request: both auth code and code verifier should be non-empty');
    expect(message?.text).toMatch(/same browser/i);
  });
});

describe('waiting', () => {
  it('turns a countdown into a wait', () => {
    const message = signInMessage('For security purposes, you can only request this after 47 seconds.');
    expect(message?.text).toContain('47 seconds');
    expect(message?.text).toMatch(/ask for another/i);
    expect(message?.retryable).toBe(false);
  });

  it('rounds a long countdown into minutes', () => {
    expect(signInMessage('you can only request this after 300 seconds')?.text).toMatch(/about 5 minutes/);
  });

  it('gets the singular right', () => {
    expect(signInMessage('you can only request this after 1 seconds')?.text).toContain('1 second.');
  });

  it('handles a rate limit with no number in it', () => {
    const message = signInMessage('Email rate limit exceeded');
    expect(message?.text).toMatch(/too many attempts/i);
    expect(message?.retryable).toBe(false);
  });
});

describe('everything else', () => {
  it('explains a network failure as a network failure', () => {
    expect(signInMessage('TypeError: Failed to fetch')?.text).toMatch(/could not reach/i);
  });

  it('says an unactivated account needs an administrator', () => {
    const message = signInMessage('Email not confirmed');
    expect(message?.text).toMatch(/administrator/i);
    expect(message?.retryable).toBe(false);
  });

  it('passes an unrecognised message through rather than hiding it', () => {
    // A message nobody has seen before is worth more verbatim than flattened
    // into "something went wrong" — it is all a support chat will have.
    expect(signInMessage('Database error granting user')?.text).toBe('Database error granting user');
  });

  it('is nothing at all when there is nothing to say', () => {
    expect(signInMessage(null)).toBeNull();
    expect(signInMessage('   ')).toBeNull();
  });
});

describe('after a link is sent', () => {
  const sent = magicLinkSent('phong@ahnmedia.com');

  it('does not confirm whether the address has an account', () => {
    expect(sent).toMatch(/^If phong@ahnmedia\.com has an account/);
  });

  it('answers the two questions people ask next', () => {
    expect(sent).toMatch(/opens once/i);
    expect(sent).toMatch(/expires/i);
    expect(sent).toMatch(/spam/i);
  });
});

describe('the sign-in surfaces all speak through it', () => {
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');

  it.each([
    'src/components/LoginForm.tsx',
    'src/components/AuthHashHandler.tsx',
    'src/app/login/page.tsx',
  ])('%s shows no raw provider string', (file) => {
    const source = read(file);
    expect(source).toContain('auth-messages');
    // The three ways a raw message used to reach the screen.
    expect(source).not.toMatch(/setStatus\(error\.message\)/);
    expect(source).not.toMatch(/text:\s*error\.message/);
    expect(source).not.toMatch(/\{searchParams\.error\}/);
  });

  /**
   * Access is by invitation. With `shouldCreateUser` left at its default, the
   * magic-link form creates an account for any address typed into it.
   */
  it('never lets the magic link create an account', () => {
    expect(read('src/components/LoginForm.tsx')).toMatch(/shouldCreateUser:\s*false/);
  });
});
