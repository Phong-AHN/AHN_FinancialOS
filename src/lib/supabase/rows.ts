/**
 * Reads that refuse to turn an error into an empty table.
 *
 * THE BUG THIS EXISTS TO PREVENT, which has now happened three times:
 *
 *   1. `loadProject` decided who may see labour cost from `!error`, on the
 *      belief that RLS refuses a viewer. It does not — a blocked read is
 *      HTTP 200 with `[]` — so a viewer was shown a net profit computed from a
 *      labour cost of zero (decision 90).
 *   2. The acceptance checklist selected two columns that do not exist,
 *      PostgREST answered 400, `(data ?? [])` made it an empty list, and
 *      eleven enabled alert rules were reported as "0 rules, all off"
 *      (decision 96).
 *   3. Which in turn meant AHN was told alerts were dormant while twelve of
 *      them were being delivered to Slack.
 *
 * Every one of those was a *confident wrong answer* rather than a visible
 * failure, and that is the expensive kind. A finance system may say "this could
 * not be loaded". It may not say "$0.00" when it means "the query failed".
 *
 * WHY THROWING IS THE RIGHT ANSWER HERE and not a defensive fallback: these
 * reads produce cash, burn and runway. A page that fails loudly sends somebody
 * to look at it. A page that renders zero gets believed.
 */

export interface SupabaseResult<T> {
  data: T[] | null;
  error: { message: string; code?: string } | null;
}

/**
 * Rows, or an exception naming what failed.
 *
 * `what` is the thing a reader would recognise — "transactions for the
 * dashboard", not the table name — because the message ends up in a server log
 * that somebody reads under time pressure.
 */
export function rowsOrThrow<T>(result: SupabaseResult<T>, what: string): T[] {
  if (result.error) {
    throw new Error(
      `Could not read ${what}: ${result.error.message}` +
        (result.error.code ? ` (${result.error.code})` : ''),
    );
  }
  return result.data ?? [];
}

/**
 * The same, for a read where an empty answer is a legitimate outcome and only
 * an *error* should stop the page.
 *
 * Identical in behaviour today; it exists so a call site can say which of the
 * two situations it is in, and so the distinction survives the next edit.
 */
export const rowsOrEmpty = rowsOrThrow;
