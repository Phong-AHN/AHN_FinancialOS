import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireSession } from '@/lib/auth';
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
 * Nothing on this page is stored. A saved projection acquires the authority of
 * a record, and a quarter later somebody reads last quarter's guess as history.
 */
export default async function SimulatorPage() {
  const supabase = createSupabaseServerClient();
  const [, { baseline, scenarios }] = await Promise.all([
    requireSession(),
    loadSimulatorBaseline(supabase),
  ]);

  const usable = baseline.monthsSampled > 0 && baseline.revenueUsdMinor > 0;
  const reliability = scenarioReliability(baseline);

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
          />
        </>
      )}
    </>
  );
}
