import { describe, expect, it } from 'vitest';
import { parseEnvLikeDotenv } from './setup-env';

/**
 * Guards the parsing rules the app actually runs under.
 *
 * The bug these exist for: a test harness that read `.env.local` more leniently
 * than Next.js does reported Slack channel routing as working while the running
 * app saw empty strings and fell back to a webhook.
 */
describe('env parsing matches dotenv', () => {
  it('treats an unquoted value starting with # as EMPTY', () => {
    // The trap. A Slack channel name is the obvious thing to write unquoted.
    const env = parseEnvLikeDotenv('SLACK_DEFAULT_CHANNEL=#ahn-finance-alerts');
    expect(env.SLACK_DEFAULT_CHANNEL).toBe('');
  });

  it('preserves a # inside quotes', () => {
    const env = parseEnvLikeDotenv('SLACK_DEFAULT_CHANNEL="#ahn-finance-alerts"');
    expect(env.SLACK_DEFAULT_CHANNEL).toBe('#ahn-finance-alerts');
  });

  it('strips a trailing inline comment', () => {
    const env = parseEnvLikeDotenv('PLAID_ENV=sandbox # not production yet');
    expect(env.PLAID_ENV).toBe('sandbox');
  });

  it('keeps values that merely contain special characters', () => {
    const env = parseEnvLikeDotenv(
      [
        'SUPABASE_DB_URL=postgresql://postgres.abc:p%40ss@aws-0-x.pooler.supabase.com:5432/postgres',
        'ENCRYPTION_KEY=aGVsbG8gd29ybGQgdGhpcyBpcyAzMiBieXRlcyE=',
      ].join('\n'),
    );
    expect(env.SUPABASE_DB_URL).toContain('pooler.supabase.com:5432');
    expect(env.ENCRYPTION_KEY!.endsWith('=')).toBe(true); // trailing base64 padding survives
  });

  it('ignores whole-line comments and blank lines', () => {
    const env = parseEnvLikeDotenv(['# a heading', '', '  ', 'A=1'].join('\n'));
    expect(Object.keys(env)).toEqual(['A']);
  });

  it('rejects lines that are not assignments', () => {
    const env = parseEnvLikeDotenv(['not a line', '1BAD=x', 'GOOD=x'].join('\n'));
    expect(Object.keys(env)).toEqual(['GOOD']);
  });
});
