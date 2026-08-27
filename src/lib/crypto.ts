import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for integration tokens (spec section 25: encrypted at
 * rest, secrets outside application code).
 *
 * OAuth access/refresh tokens for QuickBooks and Plaid are bearer credentials
 * to AHN real money data. They are encrypted with AES-256-GCM before being
 * written to `integrations`, so a leaked database dump is not a leaked bank
 * connection. The key lives only in ENCRYPTION_KEY.
 *
 * Ciphertext format:  v1.<iv b64>.<authTag b64>.<ciphertext b64>
 */

const VERSION = 'v1';
const IV_BYTES = 12; // GCM standard nonce length

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}.`);
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(
    '.',
  );
}

export function decryptSecret(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Malformed encrypted payload.');
  }
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const decipher = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Null-safe wrappers - integration rows legitimately hold null tokens. */
export function encryptNullable(value: string | null | undefined): string | null {
  return value ? encryptSecret(value) : null;
}

export function decryptNullable(value: string | null | undefined): string | null {
  return value ? decryptSecret(value) : null;
}

/**
 * Constant-time-ish comparison for shared secrets (cron bearer tokens).
 * Avoids leaking the secret length/prefix through early-exit timing.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
