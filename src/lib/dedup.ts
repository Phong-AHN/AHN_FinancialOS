/**
 * Cross-source duplicate detection - MVP Plan Day 3, Spec section 22.
 *
 * The same payment legitimately arrives twice: once from the bank feed (Plaid)
 * and once from the ledger (QuickBooks). Adding both would overstate cash,
 * which is the single most damaging thing this product could get wrong.
 *
 * Within one source the unique index on (source_system, external_txn_id) makes
 * duplication impossible. Across sources there is no shared key, so this is a
 * heuristic: same amount, same direction, same currency, dates within a small
 * window. The plan calls it "basic" for week 1 on purpose - matches are flagged
 * for a human in the reconcile queue, never silently deleted.
 *
 * QuickBooks wins ties: spec section 29 makes it the accounting source of truth,
 * so the bank-feed copy is the one flagged as the duplicate.
 */

import type { ReconStatus, SourceSystem, Transaction } from '@/lib/types';
import { daysBetween } from '@/lib/dates';

export interface DuplicateMatch {
  /** The row that stays in the totals. */
  keepId: string;
  /** The row to flag as possible_duplicate. */
  flagId: string;
  /**
   * That row's status right now. A pair re-found on a later sweep has already
   * been settled; carrying the status here lets the caller tell "newly found"
   * from "seen before" without a second round trip per pair.
   */
  flagStatus: ReconStatus;
  score: number;
  reasons: string[];
  dayGap: number;
}

export interface DedupOptions {
  /** How many days apart a bank posting and its ledger entry may be. */
  windowDays?: number;
  /** Below this, the pair is left alone. */
  minScore?: number;
}

/**
 * Lower rank = more authoritative, and therefore the row we keep.
 *
 * `finverse` sits directly beside `plaid` because it is the same kind of thing:
 * a bank feed read straight from the institution. It ranks ABOVE `csv_vn_bank`
 * deliberately - when the same Vietnamese transaction arrives from both, the
 * live feed is the one that has not been through a spreadsheet export, a
 * column mapping and somebody's date format.
 */
const SOURCE_RANK: Record<SourceSystem, number> = {
  quickbooks: 0,
  plaid: 1,
  // The bank itself outranks an aggregator reading the same bank.
  vietinbank: 2,
  finverse: 3,
  stripe: 4,
  csv_vn_bank: 5,
  csv_veem: 6,
  csv_payroll: 7,
  manual: 8,
};

type Candidate = Pick<
  Transaction,
  | 'id'
  | 'account_id'
  | 'txn_date'
  | 'amount_minor'
  | 'currency'
  | 'direction'
  | 'description'
  | 'source_system'
  | 'reconciliation_status'
  | 'created_at'
>;

/**
 * Find likely cross-source duplicates in a set of transactions.
 *
 * Bucketing by the exact amount first keeps this near-linear: only transactions
 * with an identical amount, currency and direction are ever compared.
 */
export function findDuplicates(
  transactions: Candidate[],
  options: DedupOptions = {},
): DuplicateMatch[] {
  const windowDays = options.windowDays ?? 2;
  const minScore = options.minScore ?? 0.6;

  const buckets = new Map<string, Candidate[]>();
  for (const t of transactions) {
    if (t.reconciliation_status === 'duplicate_ignored') continue;
    const key = `${t.currency.toUpperCase()}|${t.direction}|${t.amount_minor}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(t);
    else buckets.set(key, [t]);
  }

  const matches: DuplicateMatch[] = [];
  const alreadyFlagged = new Set<string>();

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    // Zero-amount rows (fee reversals, memo lines) match everything. Skip them.
    if (bucket[0]!.amount_minor === 0) continue;

    const sorted = [...bucket].sort((a, b) => a.txn_date.localeCompare(b.txn_date));

    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i]!;
        const b = sorted[j]!;

        // Two rows from the same source are already deduped by the DB key.
        if (a.source_system === b.source_system) continue;

        const dayGap = Math.abs(daysBetween(a.txn_date, b.txn_date));
        if (dayGap > windowDays) break; // sorted by date - nothing later can match

        const { score, reasons } = scorePair(a, b, dayGap);
        if (score < minScore) continue;

        const [keep, flag] = pickWinner(a, b);
        if (alreadyFlagged.has(flag.id) || alreadyFlagged.has(keep.id)) continue;

        alreadyFlagged.add(flag.id);
        matches.push({
          keepId: keep.id,
          flagId: flag.id,
          flagStatus: flag.reconciliation_status,
          score,
          reasons,
          dayGap,
        });
      }
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}

function scorePair(
  a: Candidate,
  b: Candidate,
  dayGap: number,
): { score: number; reasons: string[] } {
  const reasons: string[] = [
    `same amount and direction (${a.direction})`,
    dayGap === 0 ? 'same date' : `${dayGap} day apart`,
  ];
  // Amount + direction + currency + a tight date window is the base signal.
  let score = 0.6;

  if (dayGap === 0) {
    score += 0.15;
  } else if (dayGap === 1) {
    score += 0.05;
  }

  const similarity = descriptionSimilarity(a.description, b.description);
  if (similarity >= 0.5) {
    score += 0.2;
    reasons.push('similar description');
  } else if (similarity > 0) {
    score += 0.1;
    reasons.push('partially matching description');
  }

  if (a.source_system === 'quickbooks' || b.source_system === 'quickbooks') {
    reasons.push('ledger vs. bank feed');
  }

  return { score: Math.min(1, score), reasons };
}

/** Keep the more authoritative source; break ties by which row we saw first. */
function pickWinner(a: Candidate, b: Candidate): [Candidate, Candidate] {
  const rankA = SOURCE_RANK[a.source_system] ?? 99;
  const rankB = SOURCE_RANK[b.source_system] ?? 99;
  if (rankA !== rankB) return rankA < rankB ? [a, b] : [b, a];
  return a.created_at <= b.created_at ? [a, b] : [b, a];
}

/** Jaccard overlap on lowercased word tokens, ignoring noise words. */
export function descriptionSimilarity(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;

  let intersection = 0;
  for (const token of ta) if (tb.has(token)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const NOISE = new Set([
  'the', 'and', 'for', 'inc', 'llc', 'ltd', 'co', 'corp', 'payment', 'pmt',
  'transfer', 'purchase', 'debit', 'credit', 'card', 'ach', 'pos', 'ref', 'to',
  'from', 'of', 'on',
]);

function tokenize(value: string | null | undefined): Set<string> {
  if (!value) return new Set();
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !NOISE.has(t) && !/^\d+$/.test(t));
  return new Set(tokens);
}
