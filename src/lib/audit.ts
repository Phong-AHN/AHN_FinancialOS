/**
 * Audit trail - Spec section 24, MVP Plan Day 6.
 *
 * Every hand-edit to financial data records the old value, the new value, who
 * made the change and when. `audit_logs` has insert-only RLS (no update, no
 * delete policy), so the trail cannot be rewritten after the fact - which is
 * the only thing that makes an audit trail worth having.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppUser } from '@/lib/types';

export interface AuditEntry {
  table_name: string;
  record_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  reason?: string | null;
}

export async function recordAudit(
  db: SupabaseClient,
  entries: AuditEntry[],
  user: Pick<AppUser, 'id' | 'email'> | null,
): Promise<void> {
  if (entries.length === 0) return;
  const { error } = await db.from('audit_logs').insert(
    entries.map((e) => ({
      ...e,
      reason: e.reason ?? null,
      user_id: user?.id ?? null,
      user_email: user?.email ?? null,
    })),
  );
  if (error) throw new Error(`Failed to write audit log: ${error.message}`);
}

/**
 * Diff a patch against the current row and return one entry per changed field.
 * Unchanged fields produce nothing, so re-saving a form without touching it
 * does not fill the log with noise.
 */
export function diffForAudit(
  tableName: string,
  recordId: string,
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
  reason?: string | null,
): AuditEntry[] {
  const entries: AuditEntry[] = [];
  for (const [field, nextValue] of Object.entries(patch)) {
    const prevValue = before[field];
    if (serialize(prevValue) === serialize(nextValue)) continue;
    entries.push({
      table_name: tableName,
      record_id: recordId,
      field,
      old_value: serialize(prevValue),
      new_value: serialize(nextValue),
      reason: reason ?? null,
    });
  }
  return entries;
}

function serialize(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * Update a row and write its audit entries together.
 *
 * The audit write is awaited before returning: an edit that lands without a
 * trail is exactly the case spec section 24 exists to prevent, so a failure
 * here surfaces as an error rather than passing silently.
 */
export async function updateWithAudit<T extends object>(
  db: SupabaseClient,
  options: {
    table: string;
    id: string;
    patch: Partial<T>;
    user: Pick<AppUser, 'id' | 'email'> | null;
    reason?: string | null;
  },
): Promise<{ before: T; after: T; audited: number }> {
  const { data: before, error: readError } = await db
    .from(options.table)
    .select('*')
    .eq('id', options.id)
    .single();

  if (readError || !before) {
    throw new Error(`Record not found in ${options.table}: ${readError?.message ?? options.id}`);
  }

  const entries = diffForAudit(
    options.table,
    options.id,
    before as Record<string, unknown>,
    options.patch as Record<string, unknown>,
    options.reason,
  );

  if (entries.length === 0) {
    return { before: before as T, after: before as T, audited: 0 };
  }

  const { data: after, error: writeError } = await db
    .from(options.table)
    .update(options.patch as Record<string, unknown>)
    .eq('id', options.id)
    .select('*')
    .single();

  if (writeError || !after) {
    throw new Error(`Update failed on ${options.table}: ${writeError?.message}`);
  }

  await recordAudit(db, entries, options.user);
  return { before: before as T, after: after as T, audited: entries.length };
}
