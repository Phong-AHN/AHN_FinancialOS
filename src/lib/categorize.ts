/**
 * Rule-based auto-categorisation - Spec section 3 ("auto-categorize using rules
 * and AI, while allowing manual corrections") and section 7 (expense taxonomy).
 *
 * Week 1 is rules only. Rules are deterministic, auditable and free, and every
 * result is overridable by hand with an audit-log entry. The AI pass in Phase 3
 * layers on top for the leftovers, never in place of these.
 *
 * Every vendor named in spec section 7 has a rule here, so AHN known spend
 * lands in the right bucket from the first sync.
 */

import type { CounterpartyType, SourceSystem, TxnDirection } from '@/lib/types';

export interface CategoryGuess {
  category: string;
  subcategory: string | null;
  isSubscription: boolean;
  isRecurring: boolean;
  isInternalTransfer: boolean;
  counterpartyType: CounterpartyType;
  /** Which rule fired, so the UI can explain the guess. */
  matchedRule: string | null;
}

interface Rule {
  id: string;
  patterns: RegExp;
  category: string;
  subcategory?: string | null;
  direction?: TxnDirection;
  isSubscription?: boolean;
  isRecurring?: boolean;
  isInternalTransfer?: boolean;
  counterpartyType?: CounterpartyType;
}

/** Ordered: the first match wins, so put the specific rules above the broad. */
const RULES: Rule[] = [
  // ── Internal movement ────────────────────────────────────────────────────
  {
    id: 'internal-transfer',
    patterns: /\b(internal transfer|transfer to (own|savings)|book transfer|inter[- ]?account|own account)\b/i,
    category: 'transfer',
    isInternalTransfer: true,
    counterpartyType: 'internal',
  },

  // ── Revenue (inflow only) ─────────────────────────────────────────────
  // Direction-scoped rules come FIRST. They can only ever match one
  // direction, so putting them ahead costs nothing and prevents the broad
  // expense patterns from claiming an inflow: "sponsorship fee" paid OUT is
  // marketing spend, but the same words on an inflow are revenue.
  {
    id: 'rev-sponsorship',
    patterns: /\b(sponsor|sponsorship|partnership fee)\b/i,
    category: 'revenue',
    subcategory: 'sponsorship',
    direction: 'inflow',
    counterpartyType: 'customer',
  },
  {
    id: 'rev-tickets',
    patterns: /\b(ticket|eventbrite|luma|lu\.ma|registration)\b/i,
    category: 'revenue',
    subcategory: 'tickets',
    direction: 'inflow',
    counterpartyType: 'customer',
  },
  {
    id: 'rev-membership',
    patterns: /\b(membership|member dues|community subscription|patreon)\b/i,
    category: 'revenue',
    subcategory: 'membership',
    direction: 'inflow',
    isRecurring: true,
    counterpartyType: 'customer',
  },
  {
    id: 'rev-processor',
    patterns: /\b(stripe|paypal|square|shopify payments)\b/i,
    category: 'revenue',
    subcategory: 'processor_payout',
    direction: 'inflow',
    counterpartyType: 'customer',
  },
  {
    id: 'rev-invoice',
    patterns: /\b(invoice|inv[- ]?\d+|client payment|deposit from|retainer received)\b/i,
    category: 'revenue',
    subcategory: 'client_services',
    direction: 'inflow',
    counterpartyType: 'customer',
  },

  // ── People (spec 7) ──────────────────────────────────────────────────────
  {
    id: 'payroll-veem-ph',
    patterns: /\b(veem)\b/i,
    category: 'people',
    subcategory: 'ph_payroll_veem',
    isRecurring: true,
    counterpartyType: 'employee',
  },
  {
    id: 'payroll-provider',
    patterns: /\b(gusto|adp|deel|rippling|justworks|trinet|paychex|remote\.com)\b/i,
    category: 'people',
    subcategory: 'us_payroll',
    isRecurring: true,
    counterpartyType: 'employee',
  },
  {
    id: 'payroll-generic',
    patterns: /\b(payroll|salary|salaries|wages|luong)\b/i,
    category: 'people',
    subcategory: 'payroll',
    isRecurring: true,
    counterpartyType: 'employee',
  },
  {
    id: 'contractor',
    patterns: /\b(contractor|freelance|freelancer|upwork|fiverr|toptal|1099)\b/i,
    category: 'people',
    subcategory: 'contractors',
    counterpartyType: 'employee',
  },
  {
    id: 'commission-bonus',
    patterns: /\b(commission|bonus|incentive)\b/i,
    category: 'people',
    subcategory: 'commissions_bonuses',
    counterpartyType: 'employee',
  },

  // ── Software / subscriptions (spec 7 named vendors) ──────────────────────
  {
    id: 'saas-google',
    patterns: /\b(google\s*(workspace|cloud|gsuite)|g\s*suite)\b/i,
    category: 'software',
    subcategory: 'google_workspace',
    isSubscription: true,
    isRecurring: true,
    counterpartyType: 'vendor',
  },
  {
    id: 'saas-named',
    patterns: /\b(clickup|quickbooks|intuit|beehiiv|manychat|envato|digitalocean|spotify|elevenlabs|godaddy|smugmug)\b/i,
    category: 'software',
    subcategory: 'saas',
    isSubscription: true,
    isRecurring: true,
    counterpartyType: 'vendor',
  },
  {
    id: 'saas-common',
    patterns: /\b(slack|notion|figma|canva|adobe|zoom|dropbox|github|vercel|supabase|aws|amazon web services|openai|anthropic|twilio|resend|stripe billing|hubspot|mailchimp|airtable|asana|atlassian|linear|loom|calendly|zapier|cloudflare|namecheap|squarespace|wix|shopify)\b/i,
    category: 'software',
    subcategory: 'saas',
    isSubscription: true,
    isRecurring: true,
    counterpartyType: 'vendor',
  },
  {
    id: 'saas-signal',
    patterns: /\b(subscription|monthly plan|annual plan|renewal|licence|license fee|seat[s]? billing)\b/i,
    category: 'software',
    subcategory: 'saas',
    isSubscription: true,
    isRecurring: true,
    counterpartyType: 'vendor',
  },

  // ── Professional / agency services (spec 7) ──────────────────────────────
  {
    id: 'svc-legal',
    patterns: /\b(legal|attorney|law (firm|office)|counsel|retainer)\b/i,
    category: 'professional_services',
    subcategory: 'legal',
    counterpartyType: 'vendor',
  },
  {
    id: 'svc-accounting',
    patterns: /\b(accounting|bookkeep|cpa|audit|tax prep)\b/i,
    category: 'professional_services',
    subcategory: 'accounting',
    counterpartyType: 'vendor',
  },
  {
    id: 'svc-tax',
    patterns: /\b(irs|tax payment|franchise tax|estimated tax|vat|gtgt)\b/i,
    category: 'professional_services',
    subcategory: 'tax',
    counterpartyType: 'vendor',
  },
  {
    id: 'svc-creative',
    patterns: /\b(design|ui\/?ux|video|videograph|photograph|editing|animation|creative)\b/i,
    category: 'professional_services',
    subcategory: 'design_video',
    counterpartyType: 'vendor',
  },
  {
    id: 'svc-dev',
    patterns: /\b(web (dev|development)|developer|engineering|software dev|agency)\b/i,
    category: 'professional_services',
    subcategory: 'web_development',
    counterpartyType: 'vendor',
  },
  {
    id: 'svc-marketing',
    patterns: /\b(marketing|advertis\w*|ad spend|meta ads|facebook ads|google ads|tiktok ads|influencer|sponsorship fee)\b/i,
    category: 'marketing',
    subcategory: 'advertising',
    counterpartyType: 'vendor',
  },

  // ── Events (spec 14 categories, useful even before the Events P&L ships) ─
  {
    id: 'event-venue',
    patterns: /\b(venue|ballroom|banquet|conference (center|centre)|event space|deposit for event)\b/i,
    category: 'events',
    subcategory: 'venue',
    counterpartyType: 'vendor',
  },
  {
    id: 'event-catering',
    patterns: /\b(catering|caterer|food (and|&) beverage|f&b|banquet ev)\b/i,
    category: 'events',
    subcategory: 'food_beverage',
    counterpartyType: 'vendor',
  },
  {
    id: 'event-production',
    patterns: /\b(av |audio visual|staging|production crew|lighting|sound rental)\b/i,
    category: 'events',
    subcategory: 'production',
    counterpartyType: 'vendor',
  },

  // ── Ledger account names (spec §29: QuickBooks classifies, we follow) ────
  {
    id: 'ledger-vehicle',
    patterns: /\b(automobile|vehicle|fuel|gas(oline)?|mileage|car rental)\b/i,
    category: 'travel',
    subcategory: 'vehicle',
    counterpartyType: 'vendor',
  },
  {
    id: 'ledger-cogs',
    patterns: /\b(job (expenses|materials)|cost of goods|cogs|materials|supplies used|subcontract)\b/i,
    category: 'cost_of_delivery',
    subcategory: 'job_materials',
    counterpartyType: 'vendor',
  },
  {
    id: 'ledger-office',
    patterns: /\b(office (expenses|supplies)|stationery|printing|postage|shipping)\b/i,
    category: 'office',
    counterpartyType: 'vendor',
  },
  {
    id: 'ledger-facilities',
    patterns: /\b(rent|lease|utilities|electric|water|internet|telephone|phone bill|maintenance and repair|repairs?)\b/i,
    category: 'facilities',
    counterpartyType: 'vendor',
  },
  {
    id: 'ledger-insurance',
    patterns: /\b(insurance|workers.? comp|liability cover)\b/i,
    category: 'insurance',
    counterpartyType: 'vendor',
  },
  {
    id: 'ledger-equipment',
    patterns: /\b(equipment (rental|purchase)?|tools|machinery|hardware purchase)\b/i,
    category: 'equipment',
    counterpartyType: 'vendor',
  },

  // ── Travel & operations ──────────────────────────────────────────────────
  {
    id: 'travel',
    patterns: /\b(airline|airlines|air\s?fare|united|delta|american air|vietnam airlines|vietjet|bamboo airways|hotel|marriott|hilton|hyatt|airbnb|uber|lyft|grab|booking\.com|expedia)\b/i,
    category: 'travel',
    subcategory: null,
    counterpartyType: 'vendor',
  },
  {
    id: 'meals',
    patterns: /\b(restaurant|cafe|coffee|starbucks|doordash|ubereats|grubhub|meals?|entertainment|dining)\b/i,
    category: 'meals_entertainment',
    counterpartyType: 'vendor',
  },
  {
    id: 'bank-fees',
    patterns: /\b(bank fee|service charge|wire fee|overdraft|interest charge|fx fee|foreign transaction fee|phi dich vu)\b/i,
    category: 'bank_fees',
    counterpartyType: 'vendor',
  },
  {
    id: 'processor-fees',
    patterns: /\b(stripe fee|paypal fee|processing fee|merchant fee)\b/i,
    category: 'bank_fees',
    subcategory: 'processing',
    counterpartyType: 'vendor',
  },

];

export interface CategorizeInput {
  description?: string | null;
  counterpartyName?: string | null;
  category?: string | null;
  /**
   * The chart-of-accounts name the ledger assigned, e.g. "Automobile:Fuel" or
   * "Legal & Professional Fees:Lawyer".
   *
   * QuickBooks is the accounting source of truth (spec §29), so when it has
   * already classified a transaction that judgement beats anything inferred
   * from a bank memo. Ignoring it means telling the CEO a payment is
   * uncategorised while the ledger sitting next to it says exactly what it was.
   */
  ledgerAccount?: string | null;
  /**
   * Which connector the row came from.
   *
   * For the CSV rails this is often the ONLY signal there is. A VEEM payroll
   * export names the recipient and nothing else - "Jomar Reyes" says nothing
   * about what the payment was for - but the file being a VEEM export says it
   * is Philippines payroll with certainty no description could match.
   */
  sourceSystem?: SourceSystem | null;
  direction: TxnDirection;
}

/** Rails that exist for one purpose, so the file itself settles the category. */
const SOURCE_CATEGORIES: Partial<Record<SourceSystem, Omit<CategoryGuess, 'matchedRule'>>> = {
  csv_veem: {
    category: 'people',
    subcategory: 'ph_payroll_veem',
    isSubscription: false,
    isRecurring: true,
    isInternalTransfer: false,
    counterpartyType: 'employee',
  },
  csv_payroll: {
    category: 'people',
    subcategory: 'payroll',
    isSubscription: false,
    isRecurring: true,
    isInternalTransfer: false,
    counterpartyType: 'employee',
  },
};

export function categorize(input: CategorizeInput): CategoryGuess {
  // A VEEM or payroll export is payroll by definition. Only outflows, though -
  // money arriving on a payroll rail is a refund or a top-up, not a salary.
  if (input.direction === 'outflow' && input.sourceSystem) {
    const bySource = SOURCE_CATEGORIES[input.sourceSystem];
    if (bySource) return { ...bySource, matchedRule: `source:${input.sourceSystem}` };
  }

  // The ledger account goes FIRST: it is the most authoritative signal, and the
  // rules are ordered so a specific match beats a broad one.
  const haystack = [input.ledgerAccount, input.description, input.counterpartyName, input.category]
    .filter(Boolean)
    .join(' ');

  for (const rule of RULES) {
    if (rule.direction && rule.direction !== input.direction) continue;
    if (!rule.patterns.test(haystack)) continue;
    return {
      category: rule.category,
      subcategory: rule.subcategory ?? null,
      isSubscription: rule.isSubscription ?? false,
      isRecurring: rule.isRecurring ?? rule.isSubscription ?? false,
      isInternalTransfer: rule.isInternalTransfer ?? false,
      counterpartyType: rule.counterpartyType ?? (input.direction === 'inflow' ? 'customer' : 'vendor'),
      matchedRule: rule.id,
    };
  }

  // No rule fired. Land it in the "missing category" queue (spec 22) rather
  // than guessing - an unreviewed wrong category is worse than a blank one.
  return {
    category: input.direction === 'inflow' ? 'revenue' : 'uncategorized',
    subcategory: null,
    isSubscription: false,
    isRecurring: false,
    isInternalTransfer: false,
    counterpartyType: input.direction === 'inflow' ? 'customer' : 'vendor',
    matchedRule: null,
  };
}

/** Human labels for the taxonomy above. */
export const CATEGORY_LABELS: Record<string, string> = {
  revenue: 'Revenue',
  people: 'People',
  software: 'Software & subscriptions',
  professional_services: 'Professional services',
  marketing: 'Marketing',
  events: 'Events',
  travel: 'Travel',
  meals_entertainment: 'Meals & entertainment',
  bank_fees: 'Bank & processing fees',
  cost_of_delivery: 'Cost of delivery',
  office: 'Office',
  facilities: 'Facilities & utilities',
  insurance: 'Insurance',
  equipment: 'Equipment',
  transfer: 'Internal transfer',
  uncategorized: 'Uncategorized',
};

export function categoryLabel(category: string | null | undefined): string {
  if (!category) return 'Uncategorized';
  return CATEGORY_LABELS[category] ?? category.replace(/_/g, ' ');
}

/** Canonical vendor key so "GOOGLE *WORKSPACE_AH" and "Google Workspace" merge. */
export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return 'unknown';
  return raw
    .toLowerCase()
    .replace(/[*#]/g, ' ')
    .replace(/\b(inc|llc|ltd|co|corp|corporation|company|pte|pty)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'unknown';
}
