/**
 * Demo data - roughly seven months of realistic AHN money movement.
 *
 * Why this exists: the dashboard cannot be judged, and the calc engine cannot
 * be sanity-checked, against an empty database. This produces a company that
 * looks like AHN as described in the spec - US payroll, Vietnamese payroll in
 * VND, Philippines payroll through VEEM, the exact SaaS stack listed in spec
 * section 7, event and client revenue - so every screen has something true to
 * show before a single real credential exists.
 *
 * Deterministic: a fixed PRNG seed means re-running produces identical rows,
 * and the (source_system, external_txn_id) key means re-running never
 * double-counts.
 *
 * It deliberately plants three things worth looking at:
 *   - two cross-source duplicates, so the reconcile queue is not empty
 *   - two SaaS price increases, which Phase 2 subscription intelligence
 *     will pick up
 *   - a handful of uncategorised rows, so the data-quality queue is honest
 */

const MONTHS_OF_HISTORY = 7;

// ─── Deterministic randomness ───────────────────────────────────────────────

function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260826);

const pick = (list) => list[Math.floor(rand() * list.length)];
const jitter = (base, spread) => Math.round(base * (1 + (rand() - 0.5) * 2 * spread));

// ─── Date helpers ───────────────────────────────────────────────────────────

const TODAY = new Date();
const iso = (d) => d.toISOString().slice(0, 10);

function monthsAgo(n) {
  return new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() - n, 1));
}
function dayIn(monthDate, day) {
  const last = new Date(
    Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), Math.min(day, last)));
}
/** Never emit a future-dated transaction. */
const notFuture = (d) => d <= TODAY;

// ─── The company ────────────────────────────────────────────────────────────

const COMPANIES = [
  { key: 'us', name: 'AHN Media LLC', country: 'US', currency: 'USD' },
  { key: 'vn', name: 'AHN Vietnam Co. Ltd', country: 'VN', currency: 'VND' },
];

const ACCOUNTS = [
  { key: 'us_op',  company: 'us', name: 'Chase — US Operating',        type: 'checking',          currency: 'USD', source: 'plaid',       mask: '4471', opening: 18_500_00, cash: true },
  { key: 'us_sav', company: 'us', name: 'Chase — Reserve',             type: 'savings',           currency: 'USD', source: 'plaid',       mask: '9920', opening: 120_000_00, cash: true },
  { key: 'amex',   company: 'us', name: 'Amex Business Platinum',      type: 'credit_card',       currency: 'USD', source: 'plaid',       mask: '1007', opening: 0, cash: false },
  { key: 'stripe', company: 'us', name: 'Stripe balance',              type: 'payment_processor', currency: 'USD', source: 'stripe',      mask: null,   opening: 0, cash: true },
  { key: 'vn',     company: 'vn', name: 'Techcombank — AHN Vietnam',   type: 'checking',          currency: 'VND', source: 'csv_vn_bank', mask: '8832', opening: 940_000_000, cash: true },
  { key: 'veem',   company: 'us', name: 'VEEM — Philippines payroll',  type: 'payment_processor', currency: 'USD', source: 'csv_veem',    mask: null,   opening: 6_000_00, cash: true },
];

/** Spec section 7 names every one of these. */
const SUBSCRIPTIONS = [
  { vendor: 'Google Workspace', cents: 348_00, sub: 'google_workspace', bump: { month: 2, to: 396_00 } },
  { vendor: 'ClickUp',          cents: 145_00, sub: 'saas' },
  { vendor: 'QuickBooks Online',cents: 99_00,  sub: 'saas' },
  { vendor: 'Beehiiv',          cents: 99_00,  sub: 'saas' },
  { vendor: 'ManyChat',         cents: 65_00,  sub: 'saas' },
  { vendor: 'Envato Elements',  cents: 33_00,  sub: 'saas' },
  { vendor: 'DigitalOcean',     cents: 186_00, sub: 'saas' },
  { vendor: 'Spotify',          cents: 19_99,  sub: 'saas' },
  { vendor: 'ElevenLabs',       cents: 99_00,  sub: 'saas', bump: { month: 3, to: 132_00 } },
  { vendor: 'GoDaddy',          cents: 24_99,  sub: 'saas' },
  { vendor: 'SmugMug',          cents: 13_00,  sub: 'saas' },
  { vendor: 'Slack',            cents: 262_50, sub: 'saas' },
  { vendor: 'Adobe Creative Cloud', cents: 179_88, sub: 'saas' },
  { vendor: 'Figma',            cents: 135_00, sub: 'saas' },
];

const CLIENTS = [
  'Nguyen Holdings', 'Pacific Rim Ventures', 'Saigon Coffee Co', 'Lotus Beauty Labs',
  'Kimchi Kitchen Group', 'Tanaka Logistics', 'Bayan Foods', 'Sunrise Dental Group',
];
const SPONSORS = ['Chase for Business', 'Rakuten', 'Bank of the West', 'Grab Holdings'];
const CONTRACTORS = ['Minh Tran (design)', 'Aria Cruz (video)', 'Jomar Reyes (edit)', 'Lena Park (copy)'];
const EVENT_VENDORS = [
  ['Marriott Marquis — venue deposit', 'events', 'venue'],
  ['Golden Dragon Catering', 'events', 'food_beverage'],
  ['Encore AV Production', 'events', 'production'],
  ['Vistaprint — event signage', 'marketing', 'print'],
];

// ─── Build the transaction set ──────────────────────────────────────────────

/** FNV-1a, so an id depends only on the row content. */
function hashKey(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function buildTransactions() {
  const txns = [];
  // Ids are derived from the row content, never from a running counter. A
  // counter would renumber everything the day a previously-future row becomes
  // eligible, and the whole set would re-insert as duplicates on the next seed.
  const seen = new Map();
  const add = (t) => {
    if (!notFuture(new Date(`${t.date}T00:00:00Z`))) return;
    const base = `${t.account}|${t.date}|${t.cents}|${t.dir}|${t.desc}`;
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);
    txns.push({ ...t, extId: t.extId ?? `demo-${hashKey(base)}-${nth}` });
  };

  for (let m = MONTHS_OF_HISTORY - 1; m >= 0; m--) {
    const month = monthsAgo(m);
    const monthIndex = MONTHS_OF_HISTORY - 1 - m; // 0 = oldest
    // Revenue grows through the period, which makes the MoM tile meaningful.
    const growth = 1 + monthIndex * 0.055;

    // ── People (spec 7) ──────────────────────────────────────────────────
    for (const day of [15, 30]) {
      add({
        account: 'us_op', date: iso(dayIn(month, day)), cents: jitter(19_400_00, 0.04),
        dir: 'outflow', desc: 'Gusto payroll run — US team', party: 'Gusto',
        category: 'people', sub: 'us_payroll', source: 'plaid', recurring: true,
      });
    }
    add({
      account: 'vn', date: iso(dayIn(month, 5)), cents: jitter(412_000_000, 0.03),
      dir: 'outflow', desc: 'Chuyen luong nhan vien thang', party: 'AHN Vietnam payroll',
      category: 'people', sub: 'vn_payroll', source: 'csv_vn_bank', currency: 'VND', recurring: true,
    });
    add({
      account: 'veem', date: iso(dayIn(month, 8)), cents: jitter(4_800_00, 0.06),
      dir: 'outflow', desc: 'VEEM transfer — Philippines payroll', party: 'VEEM',
      category: 'people', sub: 'ph_payroll_veem', source: 'csv_veem', recurring: true,
    });

    // ── Funding the offshore accounts ────────────────────────────────────
    // The VN and VEEM accounts only pay salaries out; the money to do that
    // comes from the US operating account. These are internal transfers, so
    // they move each account's balance without touching revenue, expense or
    // burn - exactly the distinction countsTowardCash / countsTowardPnl draws.
    const vnFundingUsd = jitter(16_800_00, 0.05);
    add({
      account: 'us_op', date: iso(dayIn(month, 2)), cents: vnFundingUsd,
      dir: 'outflow', desc: 'Wire to Techcombank — AHN Vietnam funding',
      party: 'AHN Vietnam Co. Ltd', category: 'transfer', source: 'plaid', transfer: true,
    });
    add({
      account: 'vn', date: iso(dayIn(month, 3)), cents: Math.round(vnFundingUsd / 100 / 0.000038),
      dir: 'inflow', desc: 'Nhan tien tu cong ty me', party: 'AHN Media LLC',
      category: 'transfer', source: 'csv_vn_bank', currency: 'VND', transfer: true,
    });

    const veemFunding = jitter(5_000_00, 0.05);
    add({
      account: 'us_op', date: iso(dayIn(month, 6)), cents: veemFunding,
      dir: 'outflow', desc: 'Top-up to VEEM — Philippines payroll float',
      party: 'VEEM', category: 'transfer', source: 'plaid', transfer: true,
    });
    add({
      account: 'veem', date: iso(dayIn(month, 7)), cents: veemFunding,
      dir: 'inflow', desc: 'Funding received from Chase — US Operating',
      party: 'AHN Media LLC', category: 'transfer', source: 'csv_veem', transfer: true,
    });
    for (const name of CONTRACTORS.slice(0, 2 + Math.floor(rand() * 3))) {
      add({
        account: 'us_op', date: iso(dayIn(month, 10 + Math.floor(rand() * 14))),
        cents: jitter(1_850_00, 0.4), dir: 'outflow',
        desc: `Contractor invoice — ${name}`, party: name,
        category: 'people', sub: 'contractors', source: 'plaid',
      });
    }

    // ── Software / subscriptions ─────────────────────────────────────────
    for (const s of SUBSCRIPTIONS) {
      const increased = s.bump && monthIndex >= s.bump.month;
      add({
        account: 'amex', date: iso(dayIn(month, 3 + Math.floor(rand() * 5))),
        cents: increased ? s.bump.to : s.cents, dir: 'outflow',
        desc: `${s.vendor} — monthly subscription`, party: s.vendor,
        category: 'software', sub: s.sub, source: 'plaid',
        recurring: true, subscription: true,
      });
    }

    // ── Professional services ────────────────────────────────────────────
    add({
      account: 'us_op', date: iso(dayIn(month, 12)), cents: jitter(2_400_00, 0.2),
      dir: 'outflow', desc: 'Monthly bookkeeping and close', party: 'Ledgerly CPA',
      category: 'professional_services', sub: 'accounting', source: 'quickbooks', recurring: true,
    });
    if (monthIndex % 2 === 0) {
      add({
        account: 'us_op', date: iso(dayIn(month, 18)), cents: jitter(3_500_00, 0.3),
        dir: 'outflow', desc: 'Legal retainer — contracts review', party: 'Whitfield & Cho LLP',
        category: 'professional_services', sub: 'legal', source: 'quickbooks',
      });
    }

    // ── Marketing ────────────────────────────────────────────────────────
    add({
      account: 'amex', date: iso(dayIn(month, 6)), cents: jitter(4_200_00, 0.35),
      dir: 'outflow', desc: 'Meta Ads — community growth', party: 'Meta Platforms',
      category: 'marketing', sub: 'advertising', source: 'plaid',
    });

    // ── Revenue: client work ─────────────────────────────────────────────
    const invoiceCount = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < invoiceCount; i++) {
      const client = pick(CLIENTS);
      add({
        account: 'us_op', date: iso(dayIn(month, 4 + Math.floor(rand() * 22))),
        cents: Math.round(jitter(12_500_00, 0.45) * growth), dir: 'inflow',
        desc: `Invoice payment — ${client}`, party: client,
        category: 'revenue', sub: 'client_services', source: 'quickbooks',
      });
    }

    // ── Revenue: sponsorship + membership through Stripe ──────────────────
    add({
      account: 'us_op', date: iso(dayIn(month, 20)),
      cents: Math.round(jitter(18_000_00, 0.3) * growth), dir: 'inflow',
      desc: `Sponsorship — ${pick(SPONSORS)}`, party: pick(SPONSORS),
      category: 'revenue', sub: 'sponsorship', source: 'quickbooks',
    });

    for (let week = 0; week < 4; week++) {
      const gross = Math.round(jitter(3_100_00, 0.25) * growth);
      const day = iso(dayIn(month, 2 + week * 7));
      add({
        account: 'stripe', date: day, cents: gross, dir: 'inflow',
        desc: 'Membership subscriptions — weekly settlement', party: 'Stripe',
        category: 'revenue', sub: 'membership', source: 'stripe', recurring: true,
      });
      add({
        account: 'stripe', date: day, cents: Math.round(gross * 0.029) + 30 * 12,
        dir: 'outflow', desc: 'Stripe processing fees', party: 'Stripe',
        category: 'bank_fees', sub: 'processing', source: 'stripe',
      });
      add({
        account: 'stripe', date: iso(dayIn(month, 4 + week * 7)), cents: Math.round(gross * 0.96),
        dir: 'outflow', desc: 'Payout to Chase — US Operating', party: 'Stripe payout',
        category: 'transfer', source: 'stripe', transfer: true,
      });
      add({
        account: 'us_op', date: iso(dayIn(month, 4 + week * 7)), cents: Math.round(gross * 0.96),
        dir: 'inflow', desc: 'Stripe payout', party: 'Stripe payout',
        category: 'transfer', source: 'plaid', transfer: true,
      });
    }

    // ── Events, every third month ────────────────────────────────────────
    if (monthIndex % 3 === 1) {
      for (const [vendor, category, sub] of EVENT_VENDORS) {
        add({
          account: 'us_op', date: iso(dayIn(month, 14 + Math.floor(rand() * 8))),
          cents: jitter(7_500_00, 0.5), dir: 'outflow',
          desc: `AHN Summit — ${vendor}`, party: vendor,
          category, sub, source: 'quickbooks',
        });
      }
      add({
        account: 'us_op', date: iso(dayIn(month, 24)), cents: jitter(46_000_00, 0.2),
        dir: 'inflow', desc: 'AHN Summit — ticket sales settlement', party: 'Eventbrite',
        category: 'revenue', sub: 'tickets', source: 'quickbooks',
      });
    }

    // ── Travel and odds and ends ─────────────────────────────────────────
    add({
      account: 'amex', date: iso(dayIn(month, 9)), cents: jitter(1_240_00, 0.5),
      dir: 'outflow', desc: 'Vietnam Airlines — SGN/SFO', party: 'Vietnam Airlines',
      category: 'travel', source: 'plaid',
    });
    add({
      account: 'us_op', date: iso(dayIn(month, 28)), cents: jitter(38_00, 0.4),
      dir: 'outflow', desc: 'Account maintenance fee', party: 'Chase',
      category: 'bank_fees', source: 'plaid',
    });
    // Paying the card is a transfer: money leaves the bank and reduces the
    // card liability. Booking it as an outflow ON the card (the obvious-looking
    // mistake) drives the balance further negative instead of settling it.
    const amexPayment = jitter(7_100_00, 0.15);
    add({
      account: 'us_op', date: iso(dayIn(month, 27)), cents: amexPayment,
      dir: 'outflow', desc: 'Amex payment — statement balance', party: 'American Express',
      category: 'transfer', source: 'plaid', transfer: true,
    });
    add({
      account: 'amex', date: iso(dayIn(month, 27)), cents: amexPayment,
      dir: 'inflow', desc: 'Payment received — thank you', party: 'American Express',
      category: 'transfer', source: 'plaid', transfer: true,
    });

    // A few rows no rule can classify, so the data-quality queue is honest.
    if (monthIndex % 2 === 0) {
      add({
        account: 'us_op', date: iso(dayIn(month, 21)), cents: jitter(640_00, 0.7),
        dir: 'outflow', desc: 'ACH DEBIT 8827341 REF#00921', party: null,
        category: 'uncategorized', source: 'plaid',
      });
    }
  }

  // ── Two deliberate cross-source duplicates ─────────────────────────────
  // The same payment as the bank sees it and as the ledger recorded it. The
  // dedup pass should flag the Plaid copy and keep the QuickBooks one.
  const lastMonth = monthsAgo(1);
  for (const [i, amount] of [8_750_00, 2_400_00].entries()) {
    const date = iso(dayIn(lastMonth, 11 + i));
    const party = i === 0 ? 'Pacific Rim Ventures' : 'Ledgerly CPA';
    const dir = i === 0 ? 'inflow' : 'outflow';
    add({
      account: 'us_op', date, cents: amount, dir,
      desc: `${party} — recorded in QuickBooks`, party,
      category: dir === 'inflow' ? 'revenue' : 'professional_services',
      source: 'quickbooks', extId: `demo-dup-qbo-${i}`,
    });
    add({
      account: 'us_op', date, cents: amount, dir,
      desc: `${party} — bank feed`, party,
      category: dir === 'inflow' ? 'revenue' : 'professional_services',
      source: 'plaid', extId: `demo-dup-plaid-${i}`,
    });
  }

  return txns;
}


// ─── Write ──────────────────────────────────────────────────────────────────

/**
 * Writes through the Supabase REST client with the service-role key, not a
 * direct Postgres connection.
 *
 * Seeding is pure INSERT/UPDATE - no DDL - so it needs nothing the running app
 * does not already have. That matters in practice: Supabase's direct
 * `db.<ref>.supabase.co` host is IPv6-only on many projects and simply fails to
 * resolve from an IPv4 network, whereas the REST endpoint always works.
 */
export async function seed(supabase) {
  const rates = { USD: 1, VND: 0.000038 };

  // ── Companies ─────────────────────────────────────────────────────────────
  // `companies` has no unique constraint on name (a real business may run two
  // entities under one trading name), so upsert cannot dedupe here. Look first,
  // insert only if absent - otherwise a second run forks every account onto a
  // duplicate company.
  const companyIds = {};
  for (const c of COMPANIES) {
    const { data: found, error: findError } = await supabase
      .from('companies')
      .select('id')
      .eq('name', c.name)
      .maybeSingle();
    if (findError) throw new Error(`companies lookup: ${findError.message}`);

    if (found) {
      companyIds[c.key] = found.id;
      continue;
    }
    const { data, error } = await supabase
      .from('companies')
      .insert({ name: c.name, entity_country: c.country, currency: c.currency })
      .select('id')
      .single();
    if (error) throw new Error(`companies insert: ${error.message}`);
    companyIds[c.key] = data.id;
  }

  // ── Accounts ──────────────────────────────────────────────────────────────
  const { data: accountRows, error: accountError } = await supabase
    .from('financial_accounts')
    .upsert(
      ACCOUNTS.map((a) => ({
        company_id: companyIds[a.company],
        name: a.name,
        type: a.type,
        currency: a.currency,
        source_system: a.source,
        external_account_id: `demo-${a.key}`,
        mask: a.mask,
        opening_balance_minor: a.opening,
        include_in_cash: a.cash,
      })),
      { onConflict: 'source_system,external_account_id' },
    )
    .select('id,external_account_id');
  if (accountError) throw new Error(`accounts: ${accountError.message}`);

  const accountIds = {};
  for (const row of accountRows) accountIds[row.external_account_id.replace(/^demo-/, '')] = row.id;

  // ── Counterparties ────────────────────────────────────────────────────────
  const txns = buildTransactions();

  const wanted = new Map();
  for (const t of txns) {
    if (!t.party) continue;
    const normalized = normalizeName(t.party);
    const type = t.dir === 'inflow' ? 'customer' : 'vendor';
    wanted.set(`${normalized}|${type}`, {
      name: t.party.slice(0, 200),
      normalized_name: normalized,
      type,
      source_system: t.source,
    });
  }

  const { data: partyRows, error: partyError } = await supabase
    .from('counterparties')
    .upsert([...wanted.values()], { onConflict: 'normalized_name,type' })
    .select('id,normalized_name,type');
  if (partyError) throw new Error(`counterparties: ${partyError.message}`);

  const partyIds = new Map(partyRows.map((r) => [`${r.normalized_name}|${r.type}`, r.id]));

  // ── Transactions ──────────────────────────────────────────────────────────
  const payload = txns.map((t) => {
    const currency = t.currency ?? 'USD';
    const type = t.dir === 'inflow' ? 'customer' : 'vendor';
    return {
      account_id: accountIds[t.account],
      counterparty_id: t.party ? (partyIds.get(`${normalizeName(t.party)}|${type}`) ?? null) : null,
      txn_date: t.date,
      amount_minor: t.cents,
      currency,
      direction: t.dir,
      amount_usd_minor: currency === 'USD' ? t.cents : Math.round(t.cents * rates.VND * 100),
      fx_rate: currency === 'USD' ? 1 : rates.VND,
      description: t.desc,
      category: t.category ?? null,
      subcategory: t.sub ?? null,
      is_internal_transfer: Boolean(t.transfer),
      is_recurring: Boolean(t.recurring),
      is_subscription: Boolean(t.subscription),
      source_system: t.source,
      external_txn_id: t.extId,
      reconciliation_status: 'unreconciled',
    };
  });

  // Batched: one request with several hundred rows risks a payload limit, and a
  // partial failure is far easier to diagnose per chunk.
  let inserted = 0;
  const CHUNK = 200;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const chunk = payload.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('transactions')
      .upsert(chunk, { onConflict: 'source_system,external_txn_id', ignoreDuplicates: true })
      .select('id');
    if (error) throw new Error(`transactions (rows ${i}-${i + chunk.length}): ${error.message}`);
    inserted += data?.length ?? 0;
    process.stdout.write(`\r  transactions … ${Math.min(i + CHUNK, payload.length)}/${payload.length}`);
  }
  process.stdout.write('\n');

  // ── Provider-reported balances ────────────────────────────────────────────
  // Set to agree with the transactions just written, so the Accounts page shows
  // a clean reconciliation. VEEM and the VN bank get none: CSV sources have no
  // live balance feed, which is the real situation and worth showing as such.
  for (const a of ACCOUNTS) {
    if (a.source === 'csv_veem' || a.source === 'csv_vn_bank') continue;
    const net = payload
      .filter((p) => p.account_id === accountIds[a.key])
      .reduce((sum, p) => sum + (p.direction === 'inflow' ? p.amount_minor : -p.amount_minor), 0);

    const { error } = await supabase
      .from('financial_accounts')
      .update({
        reported_balance_minor: a.opening + net,
        reported_balance_at: new Date().toISOString(),
      })
      .eq('id', accountIds[a.key]);
    if (error) throw new Error(`balance for ${a.name}: ${error.message}`);
  }

  // ── Suppress the alert backlog ────────────────────────────────────────────
  // Let the engine treat the backfill as history rather than as 400 new events
  // to page the CEO about. Rows dated today stay unalerted, so the first real
  // sync still has something genuine to fire on.
  const todayIso = new Date().toISOString().slice(0, 10);
  const { error: alertError } = await supabase
    .from('transactions')
    .update({ alerted_at: new Date().toISOString() })
    .is('alerted_at', null)
    .lt('txn_date', todayIso);
  if (alertError) throw new Error(`alert backfill: ${alertError.message}`);

  const { count } = await supabase.from('transactions').select('id', { count: 'exact', head: true });

  console.log(
    `  ${inserted} new transactions written (${count} in the table) across ${ACCOUNTS.length} accounts.`,
  );
  return { inserted, total: count };
}

function normalizeName(raw) {
  return (
    String(raw)
      .toLowerCase()
      .replace(/[*#]/g, ' ')
      .replace(/\b(inc|llc|ltd|co|corp|corporation|company|pte|pty)\b/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'unknown'
  );
}
