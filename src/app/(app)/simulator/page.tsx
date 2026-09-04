import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { SavedScenario } from '@/lib/types';
import { requireSession, sessionCan } from '@/lib/auth';
import { loadSimulatorBaseline } from '@/lib/data';
import { scenarioReliability } from '@/lib/calc/simulator';
import { Simulator } from '@/components/Simulator';
import { Callout, Card, EmptyState, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Revenue growth and margin simulator - Spec section 11.
 *
 * The baseline is the company's own last twelve complete months, and so are the
 * three preset scenarios: the weakest month, the median, the strongest. Picking
 * 5/10/20% instead would have produced three authoritative-looking numbers with
 * no relationship to this business.
 *
 * SAVING ONE WAS DELIBERATELY REFUSED FOR A LONG TIME, and the reason still
 * holds: a stored projection acquires the authority of a record, and a quarter
 * later somebody reads last quarter's guess as history. What changed is that
 * the concern now has an answer rather than a prohibition (decision 101):
 *
 *   - Only the INPUTS and the BASELINE are stored. Every figure is recomputed
 *     on read, so a saved plan can never disagree with a fresh one built from
 *     the same inputs.
 *   - The baseline is frozen with it. A plan made in June compounded June's
 *     revenue; re-running it against today's would silently change what
 *     somebody agreed to.
 *   - It is labelled a plan everywhere it appears, with the date it was made
 *     and the month its baseline came from. No page adds it to an actual.
 */
export default async function SimulatorPage() {
  const supabase = createSupabaseServerClient();
  const [session, { baseline, scenarios }, savedRes] = await Promise.all([
    requireSession(),
    loadSimulatorBaseline(supabase),
    // A saved scenario is a PROJECTION. It is loaded here and labelled as one
    // wherever it appears; nothing adds it to an actual.
    supabase
      .from('scenarios')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  const usable = baseline.monthsSampled > 0 && baseline.revenueUsdMinor > 0;
  const reliability = scenarioReliability(baseline);
  const canSave = sessionCan(session, 'move_money');
  const saved = (savedRes.data ?? []) as SavedScenario[];

  return (
    <>
      <PageHeader
        title="Growth & margin"
        subtitle="What a growth rate implies, and what a margin would require."
      />

      {!usable ? (
        <Card>
          <EmptyState
            title="Not enough history to plan from"
            body={`A projection needs at least one complete month of revenue to grow from. ${baseline.monthsSampled} complete month${baseline.monthsSampled === 1 ? ' has' : 's have'} been recorded so far, and the revenue in them totals nothing — so there is no base to compound. Connect the accounts or import the statements first.`}
          />
        </Card>
      ) : (
        <>
          {!reliability.reliable && (
            <div className="mb-5">
              <Callout tone="warn" title="Treat the preset scenarios as indicative">
                {reliability.reason} They are still derived from AHN&rsquo;s own months rather
                than invented, which is why they are shown — but the custom rate is the honest
                option until there is more history to read.
              </Callout>
            </div>
          )}
          <Simulator
            baseline={baseline}
            scenarios={scenarios}
            scenariosReliable={reliability.reliable}
            saved={saved}
            canSave={canSave}
          />
        </>
      )}
    </>
  );
}
