import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load .env.local for the integration tests, **the way Next.js does**.
 *
 * This file used to use a looser regex, and that hid a real bug for days:
 * `SLACK_DEFAULT_CHANNEL=#ahn-finance-alerts` parsed fine here, so the tests saw
 * a channel and reported per-severity Slack routing as working — while the
 * running app, which parses with dotenv, saw an EMPTY string (dotenv treats an
 * unquoted `#` as the start of a comment) and silently fell back to the incoming
 * webhook. Every alert went to one channel, from a bot identity that cannot even
 * delete its own messages.
 *
 * A test harness that reads configuration differently from the application is
 * not testing the application. These rules follow dotenv:
 *
 *   - `KEY=value`            → trimmed
 *   - `KEY=value # comment`  → comment stripped
 *   - `KEY=#value`           → EMPTY, the trap above
 *   - `KEY="#value"`         → quotes preserve everything inside
 *
 * Integration tests skip themselves when these values are absent, so a fresh
 * clone still runs a green suite with no credentials.
 */
export function parseEnvLikeDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();

    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.lastIndexOf(quote);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
      if (quote === '"') value = value.replace(/\\n/g, '\n');
    } else {
      // Unquoted: everything from an unescaped # onwards is a comment. A value
      // that STARTS with # is therefore empty - exactly the trap.
      const hash = value.indexOf('#');
      if (hash !== -1) value = value.slice(0, hash);
      value = value.trim();
    }

    out[key] = value;
  }

  return out;
}

for (const file of ['.env.local', '.env']) {
  try {
    const parsed = parseEnvLikeDotenv(readFileSync(join(process.cwd(), file), 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // Optional.
  }
}
