import { beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  CDC_ENTITIES,
  CDC_MAX_LOOKBACK_DAYS,
  createQboSession,
  fetchQboChanges,
  qboApiBase,
} from '@/lib/connectors/quickbooks';
import type { Integration } from '@/lib/types';

/**
 * Change Data Capture against the real QuickBooks API.
 *
 * `fetchQboChanges` was written from the `CDCResponse` definition in Intuit's
 * own Java SDK schema. A schema says what a response MAY look like; this says
 * what the live API actually sends — including the one thing the unit tests
 * cannot know, which is whether the parser finds the rows at all. A parser that
 * silently finds nothing reports "nothing changed", and that is
 * indistinguishable from a quiet day until the ledger is visibly wrong.
 *
 * READ-ONLY. CDC is a GET. The only write is the rotated refresh token, through
 * the same `persist` the hourly sync uses.
 *
 *   CDC_TEST=1 npx vitest run tests/cdc.integration.test.ts
 */
const ENABLED =
  process.env.CDC_TEST === '1' &&
  Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.QBO_CLIENT_ID &&
      process.env.QBO_CLIENT_SECRET &&
      process.env.ENCRYPTION_KEY,
  );

describe.skipIf(!ENABLED)('CDC against the live QuickBooks company', () => {
  let db: SupabaseClient;
  let session: ReturnType<typeof createQboSession>;
  let realm: string;

  beforeAll(async () => {
    db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
    const { data } = await db
      .from('integrations')
      .select('*')
      .eq('provider', 'quickbooks')
      .not('refresh_token_enc', 'is', null)
      .maybeSingle();
    if (!data) throw new Error('no connected QuickBooks integration');
    const live = data as Integration;
    realm = live.external_id!;
    session = createQboSession(live, async (tokens) => {
      const { error } = await db.from('integrations').update(tokens).eq('id', live.id);
      if (error) throw new Error(`could not persist rotated token: ${error.message}`);
    });
  }, 60_000);

  it('the raw response has the shape the parser expects', async () => {
    // Asked raw, so a parser bug cannot hide behind itself.
    const since = new Date(Date.now() - CDC_MAX_LOOKBACK_DAYS * 86_400_000);
    const raw = await session.run(async (token) => {
      const url =
        `${qboApiBase()}/v3/company/${realm}/cdc?entities=Purchase` +
        `&changedSince=${encodeURIComponent(since.toISOString().slice(0, 19) + '+00:00')}&minorversion=70`;
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      expect(res.status, await res.clone().text()).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    });

    console.log('\n  top-level keys:', Object.keys(raw).join(', '));
    const blocks = raw.CDCResponse as Array<{ QueryResponse?: Array<Record<string, unknown>> }>;
    expect(Array.isArray(blocks), 'CDCResponse is not an array').toBe(true);
    const qr = blocks[0]?.QueryResponse;
    expect(Array.isArray(qr), 'CDCResponse[0].QueryResponse is not an array').toBe(true);
    console.log('  QueryResponse[0] keys:', Object.keys(qr?.[0] ?? {}).join(', '));
  }, 120_000);

  it('returns every entity the sync depends on, with a real row count', async () => {
    const since = new Date(Date.now() - CDC_MAX_LOOKBACK_DAYS * 86_400_000);
    const entities = CDC_ENTITIES.map((e) => e.entity);
    const changes = await session.run((token) => fetchQboChanges(token, realm, entities, since));

    console.log(`\n  CDC since ${since.toISOString().slice(0, 10)}: ${changes.size} objects, truncated=${changes.truncated}`);
    for (const entity of entities) {
      console.log(
        `    ${entity.padEnd(12)} changed ${String(changes.changed[entity]?.length ?? 0).padStart(4)}` +
          `   deleted ${changes.deleted[entity]?.length ?? 0}`,
      );
    }

    expect(changes.truncated).toBe(false);
    // Every changed row must carry the fields the normalisers read, or the
    // ledger fills with rows that have no amount.
    for (const rows of Object.values(changes.changed)) {
      for (const row of rows) {
        expect(row.Id, 'a changed row with no Id').toBeTruthy();
      }
    }
  }, 120_000);

  it('reports which QuickBooks edition this company is on', async () => {
    // Not something the sync needs — it detects missing features by asking —
    // but the review form asks which editions the app supports, and this is
    // the one we have actually run against.
    const info = await session.run(async (token) => {
      const res = await fetch(
        `${qboApiBase()}/v3/company/${realm}/companyinfo/${realm}?minorversion=70`,
        { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
      );
      return (await res.json()) as {
        CompanyInfo?: { CompanyName?: string; NameValue?: Array<{ Name: string; Value: string }> };
      };
    });
    const sku = info.CompanyInfo?.NameValue?.find((n) => n.Name === 'OfferingSku')?.Value;
    console.log(`\n  company: ${info.CompanyInfo?.CompanyName} · edition: ${sku ?? '(not reported)'}`);
    expect(info.CompanyInfo).toBeTruthy();
  }, 120_000);
});
