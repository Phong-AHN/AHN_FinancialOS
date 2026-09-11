import type { SupabaseClient } from '@supabase/supabase-js';
import { ProviderAuthError } from '@/lib/connectors/retry';

/**
 * Keep a provider error, in a form that can be handed to that provider's
 * support team (migration 0039).
 *
 * Intuit's review asks whether the app keeps error logs that can be shared for
 * troubleshooting, and whether it captures `intuit_tid`. Both answers depend on
 * this function being called on every failure path, and on it never writing
 * anything that should not be shared — so both are enforced here rather than at
 * each call site.
 */

export type IntegrationOperation = 'sync' | 'connect' | 'disconnect';

/**
 * Strip anything credential-shaped before it is stored.
 *
 * Nothing in this codebase deliberately puts a token in an error message. This
 * is for the day something does — a provider echoing an Authorization header
 * back in an error body, say. A log whose whole purpose is to be shared with a
 * third party is the worst possible place for a bearer token to land.
 */
export function redact(message: string): string {
  return (
    message
      .replace(/(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
      .replace(
        /\b(access_token|refresh_token|client_secret|token|code|authorization)(["']?\s*[:=]\s*["']?)[^\s"'&,}]{6,}/gi,
        '$1$2[redacted]',
      )
      // JWTs, which is what most provider access tokens are.
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted jwt]')
      .slice(0, 2000)
  );
}

/** Everything support needs from an error, and nothing else. */
export function describeError(err: unknown): {
  kind: string | null;
  httpStatus: number | null;
  faultCode: string | null;
  intuitTid: string | null;
  message: string;
} {
  if (err instanceof ProviderAuthError) {
    return {
      kind: err.kind,
      httpStatus: err.status,
      faultCode: err.faultCode,
      intuitTid: err.tid,
      message: redact(err.message),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  // A tid folded into a plain Error message — the revoke path does this.
  const tid = message.match(/intuit_tid ([A-Za-z0-9-]+)/)?.[1] ?? null;
  return { kind: null, httpStatus: null, faultCode: null, intuitTid: tid, message: redact(message) };
}

/**
 * Write one error row. NEVER throws.
 *
 * This runs inside failure handling. If logging an error could itself throw,
 * a database hiccup would replace the real error with a less useful one — or
 * abort the `markFailed` that tells a person their connection needs attention.
 */
export async function recordIntegrationError(
  db: SupabaseClient,
  input: {
    integrationId: string | null;
    provider: string;
    operation: IntegrationOperation;
    error: unknown;
  },
): Promise<void> {
  try {
    const d = describeError(input.error);
    const { error } = await db.from('integration_errors').insert({
      integration_id: input.integrationId,
      provider: input.provider,
      operation: input.operation,
      kind: d.kind,
      http_status: d.httpStatus,
      fault_code: d.faultCode,
      intuit_tid: d.intuitTid,
      message: d.message,
    });
    if (error) console.error(`[integration-errors] could not record: ${error.message}`);
  } catch (err) {
    console.error('[integration-errors] could not record', err);
  }
}
