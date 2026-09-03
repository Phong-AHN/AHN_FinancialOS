import type { SupabaseClient } from '@supabase/supabase-js';
import type { QboObligation } from '@/lib/connectors/quickbooks';
import { normalizeName } from '@/lib/categorize';
import type { ISODate } from '@/lib/dates';

/**
 * Invoices and bills from QuickBooks into `obligations` - Spec §17, §18.
 *
 * The transaction sync skips these on purpose: an invoice and the payment that
 * settles it are two records of one event, and ingesting both would double
 * every dollar AHN earns. They belong here instead, where they are money that
 * is *going* to move rather than money that has.
 */

export interface ObligationSyncResult {
  inserted: number;
  updated: number;
  settled: number;
  skipped: number;
  errors: string[];
}

/**
 * How much of an obligation is recorded as its amount.
 *
 * While it is open, that is the outstanding balance — which is what the aging
 * buckets in §17 chase and what an overdue alert is about. Once it is settled,
 * the balance is zero, and `obligations.amount_minor` carries a `> 0` check
 * because an obligation for nothing is not an obligation. The aging engine
 * reads a settled row's amount into `paid`, so the right number there is what
 * was actually settled: the contracted total.
 */
export function amountForStorage(o: QboObligation): number {
  return o.isSettled ? o.contractedAmountMinor : o.amountMinor;
}

/**
 * The day a settled obligation was settled.
 *
 * `obligations_settled_has_date` requires one, and QuickBooks does not put the
 * settlement date on the invoice — it lives on the linked Payment, a second
 * query per row. `lastChangedOn` is the day QuickBooks last touched the record,
 * which for a paid invoice is the day the payment was applied unless somebody
 * edited it afterwards.
 *
 * That is an approximation and it is treated as one: it is written to the row's
 * notes rather than presented silently as fact, and it falls back to the due
 * date rather than to today, because "we noticed it today" is not a date
 * anything financial happened.
 */
export function settledOnFor(o: QboObligation): ISODate {
  return o.lastChangedOn ?? o.issuedOn ?? o.dueOn;
}

const SETTLED_NOTE =
  'Settlement date taken from when QuickBooks last changed the invoice; ' +
  'QuickBooks does not record the payment date on the invoice itself.';

/** Match invoices to the same counterparties the ledger already uses. */
async function resolveCounterparties(
  db: SupabaseClient,
  obligations: QboObligation[],
): Promise<Map<string, string>> {
  const names = [
    ...new Set(
      obligations
        .map((o) => o.counterpartyName)
        .filter((n): n is string => Boolean(n))
        .map(normalizeName),
    ),
  ];
  const map = new Map<string, string>();
  if (names.length === 0) return map;

  const { data } = await db
    .from('counterparties')
    .select('id,normalized_name')
    .in('normalized_name', names);

  for (const row of (data ?? []) as Array<{ id: string; normalized_name: string }>) {
    // First one wins. A name can exist under more than one type (a customer who
    // is also a vendor); either row points at the same organisation, and
    // guessing the type here would create a second counterparty for one company.
    if (!map.has(row.normalized_name)) map.set(row.normalized_name, row.id);
  }
  return map;
}

/**
 * Write them, keyed on QuickBooks' own id.
 *
 * Idempotent by construction: the unique index on
 * (source_system, external_id) means a sync running every ten minutes finds the
 * row it wrote last time instead of writing it again. Without that AHN would be
 * owed the same $40,000 six times before lunch.
 *
 * A row a person has since edited by hand is NOT overwritten wholesale — only
 * the fields QuickBooks is authoritative about move. QuickBooks owns the
 * amount, the dates and whether it is paid. It does not own which project the
 * work belongs to or what somebody wrote in the notes.
 */
export async function syncQboObligations(
  db: SupabaseClient,
  obligations: QboObligation[],
): Promise<ObligationSyncResult> {
  const result: ObligationSyncResult = {
    inserted: 0,
    updated: 0,
    settled: 0,
    skipped: 0,
    errors: [],
  };
  if (obligations.length === 0) return result;

  const counterparties = await resolveCounterparties(db, obligations);

  const externalIds = obligations.map((o) => o.externalId);
  const { data: existingRows } = await db
    .from('obligations')
    .select('id,external_id,status,amount_minor,notes')
    .eq('source_system', 'quickbooks')
    .in('external_id', externalIds);

  const existing = new Map<string, { id: string; status: string; amount_minor: number; notes: string | null }>();
  for (const row of (existingRows ?? []) as Array<{
    id: string;
    external_id: string;
    status: string;
    amount_minor: number;
    notes: string | null;
  }>) {
    existing.set(row.external_id, row);
  }

  for (const o of obligations) {
    const prior = existing.get(o.externalId);
    const settled = o.isSettled;
    const amount = amountForStorage(o);

    if (amount <= 0) {
      // The check constraint would reject it, and an obligation for nothing is
      // not an obligation. Counted rather than silently dropped.
      result.skipped += 1;
      continue;
    }

    const patch: Record<string, unknown> = {
      source_system: 'quickbooks',
      external_id: o.externalId,
      direction: o.direction,
      counterparty_id: o.counterpartyName
        ? (counterparties.get(normalizeName(o.counterpartyName)) ?? null)
        : null,
      counterparty_name: o.counterpartyName,
      reference: o.reference,
      description: o.description,
      amount_minor: amount,
      contracted_amount_minor: o.contractedAmountMinor,
      currency: o.currency,
      issued_on: o.issuedOn,
      due_on: o.dueOn,
      status: settled ? 'settled' : 'open',
      settled_on: settled ? settledOnFor(o) : null,
      updated_at: new Date().toISOString(),
    };

    // Only stamp the caveat on rows that are actually settled, and only once.
    if (settled && !(prior?.notes ?? '').includes('QuickBooks does not record')) {
      patch.notes = prior?.notes ? `${prior.notes}\n${SETTLED_NOTE}` : SETTLED_NOTE;
    }

    const { error } = await db
      .from('obligations')
      .upsert(patch, { onConflict: 'source_system,external_id' });

    if (error) {
      result.errors.push(`${o.externalId}: ${error.message}`);
      continue;
    }

    if (!prior) result.inserted += 1;
    else result.updated += 1;
    if (settled && prior?.status !== 'settled') result.settled += 1;
  }

  return result;
}
