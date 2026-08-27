/**
 * The single write path into `transactions`.
 *
 * Every source - QuickBooks, Plaid, Stripe, and each CSV - funnels through
 * here, which is what makes the MVP Plan section 1 promise true: when VN banks
 * or VEEM eventually get a real API, only the connector changes, not the
 * schema, not the calc engine, not the dashboard.
 *
 * Responsibilities, in order:
 *   1. resolve/create the counterparty
 *   2. apply rule-based categorisation (skipped when the source already knows)
 *   3. stamp the USD value at the rate current on the transaction date
 *   4. insert, ignoring rows already held under the same source key
 *   5. flag cross-source duplicates for human review
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Counterparty,
  NormalizedTransaction,
  Transaction,
} from '@/lib/types';
import { categorize, normalizeName } from '@/lib/categorize';
import { convertMinor, DEFAULT_CURRENCY } from '@/lib/money';
import { findDuplicates } from '@/lib/dedup';
import { loadUsdRates } from '@/lib/fx';
import { today, trailingDays, type ISODate } from '@/lib/dates';

export interface IngestResult {
  received: number;
  inserted: number;
  duplicatesSkipped: number;
  flaggedAsPossibleDuplicate: number;
  errors: string[];
}

export async function ingestTransactions(
  db: SupabaseClient,
  rows: NormalizedTransaction[],
  options: { asOf?: ISODate; runDedup?: boolean } = {},
): Promise<IngestResult> {
  const result: IngestResult = {
    received: rows.length,
    inserted: 0,
    duplicatesSkipped: 0,
    flaggedAsPossibleDuplicate: 0,
    errors: [],
  };
  if (rows.length === 0) return result;

  const asOf = options.asOf ?? today();
  const rates = await loadUsdRates(db, asOf);
  const counterpartyIds = await resolveCounterparties(db, rows, result);

  const payload = rows.map((row) => {
    const guess = categorize({
      description: row.description,
      counterpartyName: row.counterparty_name,
      category: row.category,
      // Connectors put the ledger's own account name here.
      ledgerAccount: row.subcategory,
      sourceSystem: row.source_system,
      direction: row.direction,
    });

    const currency = (row.currency || DEFAULT_CURRENCY).toUpperCase();
    const rate = rates[currency];
    const amountUsdMinor =
      rate === undefined
        ? null
        : convertMinor(row.amount_minor, currency, DEFAULT_CURRENCY, rate);

    return {
      account_id: row.account_id,
      counterparty_id: row.counterparty_name
        ? counterpartyIds.get(counterpartyKey(row.counterparty_name, guess.counterpartyType)) ?? null
        : null,
      txn_date: row.txn_date,
      posted_at: row.posted_at ?? null,
      amount_minor: Math.abs(Math.round(row.amount_minor)),
      currency,
      direction: row.direction,
      amount_usd_minor: amountUsdMinor,
      fx_rate: rate ?? null,
      description: row.description ?? null,
      // A category supplied by the source (a QuickBooks account name, a mapped
      // CSV column) beats the guess - it came from a human or the ledger.
      category: row.category ?? guess.category,
      subcategory: row.subcategory ?? guess.subcategory,
      is_internal_transfer: row.is_internal_transfer ?? guess.isInternalTransfer,
      is_recurring: row.is_recurring ?? guess.isRecurring,
      is_subscription: row.is_subscription ?? guess.isSubscription,
      source_system: row.source_system,
      external_txn_id: row.external_txn_id,
      manual_import_id: row.manual_import_id ?? null,
      notes: row.notes ?? null,
      raw: row.raw ?? null,
      reconciliation_status: 'unreconciled' as const,
    };
  });

  // ignoreDuplicates keeps re-syncs idempotent AND protects hand edits: a
  // corrected category must survive the next poll of the same transaction.
  const { data: inserted, error } = await db
    .from('transactions')
    .upsert(payload, { onConflict: 'source_system,external_txn_id', ignoreDuplicates: true })
    .select('id');

  if (error) {
    result.errors.push(`insert: ${error.message}`);
    return result;
  }

  result.inserted = inserted?.length ?? 0;
  result.duplicatesSkipped = rows.length - result.inserted;

  if (options.runDedup !== false && result.inserted > 0) {
    const sweep = await flagCrossSourceDuplicates(db, asOf, result);
    result.flaggedAsPossibleDuplicate = sweep.flagged;
  }

  return result;
}

function counterpartyKey(name: string, type: string): string {
  return `${normalizeName(name)}|${type}`;
}

/**
 * Look up every counterparty in one round trip, create the missing ones in a
 * second. Doing it per-transaction would mean hundreds of queries per sync.
 */
async function resolveCounterparties(
  db: SupabaseClient,
  rows: NormalizedTransaction[],
  result: IngestResult,
): Promise<Map<string, string>> {
  const wanted = new Map<string, { name: string; normalized: string; type: string; source: string }>();

  for (const row of rows) {
    if (!row.counterparty_name) continue;
    const guess = categorize({
      description: row.description,
      counterpartyName: row.counterparty_name,
      category: row.category,
      ledgerAccount: row.subcategory,
      sourceSystem: row.source_system,
      direction: row.direction,
    });
    const type = row.counterparty_type ?? guess.counterpartyType;
    const normalized = normalizeName(row.counterparty_name);
    wanted.set(`${normalized}|${type}`, {
      name: row.counterparty_name.trim().slice(0, 200),
      normalized,
      type,
      source: row.source_system,
    });
  }

  const map = new Map<string, string>();
  if (wanted.size === 0) return map;

  const names = [...new Set([...wanted.values()].map((v) => v.normalized))];
  const { data: existing } = await db
    .from('counterparties')
    .select('id,name,normalized_name,type')
    .in('normalized_name', names);

  for (const cp of (existing ?? []) as Counterparty[]) {
    map.set(`${cp.normalized_name}|${cp.type}`, cp.id);
  }

  const missing = [...wanted.entries()].filter(([key]) => !map.has(key));
  if (missing.length === 0) return map;

  const { data: created, error } = await db
    .from('counterparties')
    .upsert(
      missing.map(([, v]) => ({
        name: v.name,
        normalized_name: v.normalized,
        type: v.type,
        source_system: v.source,
      })),
      { onConflict: 'normalized_name,type', ignoreDuplicates: false },
    )
    .select('id,normalized_name,type');

  if (error) {
    result.errors.push(`counterparties: ${error.message}`);
    return map;
  }
  for (const cp of (created ?? []) as Counterparty[]) {
    map.set(`${cp.normalized_name}|${cp.type}`, cp.id);
  }
  return map;
}

/**
 * How far back the duplicate sweep looks.
 *
 * A bank posting and its QuickBooks twin are only days apart, so a short window
 * would seem to be enough - but the FIRST sync of any source backfills six
 * months at once, and every duplicate pair in that backfill is dated older than
 * a short window would ever reach. Those pairs would then double-count cash
 * permanently, with nothing to trigger a re-check.
 *
 * So the window matches the initial backfill depth. The scan is bucketed by
 * exact amount, so it stays near-linear rather than pairwise across the range.
 */
export const DEDUP_WINDOW_DAYS = 180;

/**
 * Cross-source duplicate pass (Spec section 22, MVP Plan Day 3).
 *
 * Idempotent and safe to run on every tick: it only ever moves a row from
 * `unreconciled`, so a human decision is never overwritten.
 */
export interface DedupSweepResult {
  /** Rows examined in the window. */
  scanned: number;
  /** Pairs the matcher believes are the same activity. */
  matched: number;
  /** Rows actually moved to possible_duplicate on this run. */
  flagged: number;
  /** Pairs found again that a previous sweep or a person already settled. */
  alreadySettled: number;
  errors: string[];
}

export async function flagCrossSourceDuplicates(
  db: SupabaseClient,
  asOf: ISODate,
  result?: IngestResult,
): Promise<DedupSweepResult> {
  const sweep: DedupSweepResult = {
    scanned: 0,
    matched: 0,
    flagged: 0,
    alreadySettled: 0,
    errors: [],
  };
  const window = trailingDays(asOf, DEDUP_WINDOW_DAYS);

  const { data, error } = await db
    .from('transactions')
    .select(
      'id,account_id,txn_date,amount_minor,currency,direction,description,source_system,reconciliation_status,created_at',
    )
    .gte('txn_date', window.from)
    .lte('txn_date', window.to);

  if (error || !data) {
    const message = `dedup scan: ${error?.message ?? 'no data'}`;
    result?.errors.push(message);
    sweep.errors.push(message);
    return sweep;
  }

  sweep.scanned = data.length;
  const matches = findDuplicates(data as Transaction[]);
  sweep.matched = matches.length;
  if (matches.length === 0) return sweep;

  for (const match of matches) {
    // Re-finding a pair that is already flagged, or that a person has ruled on,
    // is the normal steady state - every sweep from here on will see it again.
    // Skipping it silently keeps the cron log meaningful instead of reporting
    // the same two "failures" every ten minutes forever.
    if (match.flagStatus !== 'unreconciled') {
      sweep.alreadySettled++;
      continue;
    }

    // `.select()` is what makes this honest. Without it the update returns no
    // rows and no error whether it changed two rows or none, so counting
    // "no error" as success reports work that never happened - and a silent
    // dedup failure means cash is double-counted with nothing to show for it.
    const { data: updated, error: updateError } = await db
      .from('transactions')
      .update({
        reconciliation_status: 'possible_duplicate',
        duplicate_of_id: match.keepId,
        notes: `Possible duplicate of ${match.keepId} — ${match.reasons.join('; ')} (confidence ${(match.score * 100).toFixed(0)}%)`,
      })
      .eq('id', match.flagId)
      .eq('reconciliation_status', 'unreconciled') // never overwrite a human decision
      .select('id');

    if (updateError) {
      const message = `dedup flag ${match.flagId}: ${updateError.message}`;
      result?.errors.push(message);
      sweep.errors.push(message);
      continue;
    }
    if (!updated?.length) {
      // Status changed between the scan and the write - a concurrent sweep or a
      // person got there first. Not an error, and not work this run did.
      sweep.alreadySettled++;
      continue;
    }
    sweep.flagged += updated.length;
  }

  // Mark the surviving side as matched so the queue shows a resolved pair.
  const keepIds = [...new Set(matches.map((m) => m.keepId))];
  if (keepIds.length) {
    await db
      .from('transactions')
      .update({ reconciliation_status: 'matched' })
      .in('id', keepIds)
      .eq('reconciliation_status', 'unreconciled');
  }

  return sweep;
}
