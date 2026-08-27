/**
 * A `fetch` that never serves a cached response.
 *
 * Next.js App Router replaces the global `fetch` with a caching version, and it
 * caches GET requests by default. supabase-js issues GETs for every `.select()`,
 * so without this a server-side read can be answered from a previous render's
 * response - silently, with no error.
 *
 * On a financial dashboard that is not a performance nicety, it is a
 * correctness bug: the CEO sees a cash figure from an earlier request, alerts
 * quote a stale balance, and the duplicate sweep matches transaction ids that
 * no longer exist. `export const dynamic = 'force-dynamic'` does NOT cover
 * this - that controls route rendering, not the fetch cache underneath it.
 *
 * Every Supabase client in this app is built with this fetch. Cheap insurance:
 * the data is small and the database is the source of truth by design.
 */
export const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: 'no-store' });
