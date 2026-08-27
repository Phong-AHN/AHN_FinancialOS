import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { qboApiBase, qboConfigProblems, qboEnvironment } from '@/lib/connectors/quickbooks';

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.QBO_CLIENT_ID = 'test-client-id';
  process.env.QBO_CLIENT_SECRET = 'test-client-secret';
  delete process.env.QBO_ENVIRONMENT;
  delete process.env.QBO_REDIRECT_URI;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('qboEnvironment', () => {
  it('accepts the two environments Intuit actually has', () => {
    process.env.QBO_ENVIRONMENT = 'sandbox';
    expect(qboEnvironment()).toMatchObject({ environment: 'sandbox', valid: true });

    process.env.QBO_ENVIRONMENT = 'production';
    expect(qboEnvironment()).toMatchObject({ environment: 'production', valid: true });
  });

  it('treats unset as production, matching .env.example', () => {
    expect(qboEnvironment()).toMatchObject({ environment: 'production', valid: true });
  });

  it('rejects "development" instead of silently using production', () => {
    // The Plaid convention. Copying it here points sandbox credentials at the
    // live API, which surfaces much later as an opaque 401 during OAuth.
    process.env.QBO_ENVIRONMENT = 'development';
    expect(qboEnvironment()).toMatchObject({ environment: 'production', valid: false });
    expect(qboConfigProblems().join(' ')).toContain('development');
  });

  it('is case- and whitespace-insensitive', () => {
    process.env.QBO_ENVIRONMENT = '  SandBox ';
    expect(qboEnvironment()).toMatchObject({ environment: 'sandbox', valid: true });
  });
});

describe('qboApiBase', () => {
  it('points at the sandbox host only for sandbox', () => {
    process.env.QBO_ENVIRONMENT = 'sandbox';
    expect(qboApiBase()).toBe('https://sandbox-quickbooks.api.intuit.com');

    process.env.QBO_ENVIRONMENT = 'production';
    expect(qboApiBase()).toBe('https://quickbooks.api.intuit.com');
  });
});

describe('qboConfigProblems', () => {
  it('is empty when the configuration is sound', () => {
    process.env.QBO_ENVIRONMENT = 'sandbox';
    process.env.QBO_REDIRECT_URI = 'http://localhost:3000/api/integrations/quickbooks/callback';
    expect(qboConfigProblems()).toEqual([]);
  });

  it('names each missing key individually', () => {
    delete process.env.QBO_CLIENT_SECRET;
    const problems = qboConfigProblems();
    expect(problems.some((p) => p.includes('QBO_CLIENT_SECRET'))).toBe(true);
    expect(problems.some((p) => p.includes('QBO_CLIENT_ID'))).toBe(false);
  });

  it('catches a redirect URI that does not match the callback route', () => {
    process.env.QBO_REDIRECT_URI = 'http://localhost:3000/callback';
    expect(qboConfigProblems().join(' ')).toContain('QBO_REDIRECT_URI');
  });
});
