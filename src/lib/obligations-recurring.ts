import type { SupabaseClient } from '@supabase/supabase-js';
import type { ISODate } from '@/lib/dates';
import { today } from '@/lib/dates';
import { HORIZON_DAYS, isTemplate, missingInstances, type Recurrence } from '@/lib/calc/recurring';

/**
 * Create the commitments that are coming - Spec section 18.
 *
 * Section 18 is about knowing what leaves the bank before it does, and its own
 * examples are almost all recurring: payroll, VEEM payments, retainers,
 * accounting fees, taxes, software renewals. Until now `is_recurring` recorded
 * that a commitment repeated and nothing acted on it, so "cash after
 * commitments" only ever saw the rows somebody had typed. Next month's payroll
 * was invisible until the day it was entered.
 */

interface TemplateRow {
  id: string;
  direction: 'inflow' | 'outflow';
  counterparty_id: string | null;
  counterparty_name: string | null;
  project_id: string | null;
  category: string | null;
  reference: string | null;
  description: string | null;
  amount_minor: number;
  contracted_amount_minor: number | null;
  currency: string;
  due_on: ISODate;
  status: string;
  recurrence: Recurrence | null;
  recurs_until: ISODate | null;
  generated_from_id: string | null;
  notes: string | null;
}

export interface GenerateResult {
  templates: number;
  created: number;
  /** Already present, so nothing was written. The ordinary daily outcome. */
  alreadyThere: number;
  errors: string[];
}

/**
 * Fill the horizon for every recurring template.
 *
 * Idempotent twice over: the missing-instance calculation only asks for dates
 * that do not exist yet, and the unique index on
 * (generated_from_id, due_on) refuses a duplicate even if two runs overlap.
 * A daily job must not create thirty copies of March's rent.
 */
export async function generateRecurringObligations(
  db: SupabaseClient,
  opts: { asOf?: ISODate; horizonDays?: number } = {},
): Promise<GenerateResult> {
  const asOf = opts.asOf ?? today();
  const horizonDays = opts.horizonDays ?? HORIZON_DAYS;
  const result: GenerateResult = { templates: 0, created: 0, alreadyThere: 0, errors: [] };

  const { data, error } = await db
    .from('obligations')
    .select('*')
    .not('recurrence', 'is', null)
    .is('generated_from_id', null);

  if (error) {
    result.errors.push(error.message);
    return result;
  }

  const templates = ((data ?? []) as TemplateRow[]).filter(isTemplate);
  result.templates = templates.length;
  if (templates.length === 0) return result;

  for (const template of templates) {
    // What this template has already produced. Read per template rather than
    // in one sweep so the set is unambiguous: two templates for the same
    // counterparty and day are different commitments.
    const { data: existing } = await db
      .from('obligations')
      .select('due_on')
      .eq('generated_from_id', template.id);

    const have = ((existing ?? []) as Array<{ due_on: ISODate }>).map((r) => r.due_on);

    /*
     * The template's OWN due date counts as already generated.
     *
     * Otherwise the first run duplicates it: the walk starts at that date, and
     * the template itself is not in `existing` because nothing generated it.
     * The result would be two identical rows for this month's payroll.
     */
    have.push(template.due_on);

    const missing = missingInstances(
      { dueOn: template.due_on, recurrence: template.recurrence!, recursUntil: template.recurs_until },
      asOf,
      have,
      { horizonDays },
    );

    if (missing.length === 0) {
      result.alreadyThere += 1;
      continue;
    }

    const rows = missing.map((m) => ({
      direction: template.direction,
      counterparty_id: template.counterparty_id,
      counterparty_name: template.counterparty_name,
      project_id: template.project_id,
      category: template.category,
      reference: template.reference,
      description: template.description,
      amount_minor: template.amount_minor,
      contracted_amount_minor: template.contracted_amount_minor,
      currency: template.currency,
      due_on: m.dueOn,
      // Open, never settled: this is money that has not moved. `issued_on` is
      // deliberately left null — nobody has issued next month's invoice yet.
      status: 'open',
      is_recurring: true,
      recurrence: null, // an instance is not itself a template
      generated_from_id: template.id,
      notes: template.notes,
    }));

    const { error: insertError, count } = await db
      .from('obligations')
      .upsert(rows, { onConflict: 'generated_from_id,due_on', ignoreDuplicates: true, count: 'exact' });

    if (insertError) {
      result.errors.push(`${template.counterparty_name ?? template.id}: ${insertError.message}`);
      continue;
    }
    result.created += count ?? rows.length;
  }

  return result;
}
