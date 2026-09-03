/**
 * What each role may do - Spec section 23.
 *
 * THIS FILE MIRRORS `supabase/migrations/0023_capabilities.sql`, and the
 * database is the authority. Row Level Security is what actually stops a
 * request; these functions exist so the interface can hide a button the person
 * cannot use, and so a route can answer 403 with a sentence instead of letting
 * Postgres return an empty result the caller has to interpret.
 *
 * When the two disagree, the database wins and the UI is wrong — which is the
 * safe direction. `tests/rbac.integration.test.ts` runs the real policies with
 * a real token for every role, so a drift between this table and that one
 * fails a test rather than quietly granting something.
 */

import type { UserRole } from '@/lib/types';

export type Capability =
  | 'see_compensation'
  | 'see_all_money'
  | 'move_money'
  | 'categorise'
  | 'manage_integrations'
  | 'manage_people'
  | 'manage_projects'
  | 'read_audit';

/**
 * The matrix, in one place.
 *
 * Written as role -> capabilities rather than capability -> roles because that
 * is how a person reads it when asking "what can an accountant do?", which is
 * the question that actually gets asked.
 */
const ROLE_CAPABILITIES: Record<UserRole, readonly Capability[]> = {
  owner: [
    'see_compensation',
    'see_all_money',
    'move_money',
    'categorise',
    'manage_integrations',
    'manage_people',
    'manage_projects',
    'read_audit',
  ],
  // A finance admin does everything the owner does with the money. The
  // difference between them is organisational, not technical.
  cfo: [
    'see_compensation',
    'see_all_money',
    'move_money',
    'categorise',
    'manage_integrations',
    'manage_people',
    'manage_projects',
    'read_audit',
  ],
  // Reclassifying a payment is an accountant's job. Connecting a bank account,
  // setting an exchange rate and changing what a person costs are not.
  accountant: ['see_compensation', 'see_all_money', 'categorise', 'read_audit'],
  // Scoped to the unit they lead. Deliberately sees LESS than a viewer: a
  // viewer is trusted with the whole picture, a lead is trusted with theirs.
  department_lead: ['manage_projects'],
  project_manager: [],
  employee: [],
  // Read-only across the company, minus compensation.
  viewer: ['see_all_money'],
};

export function can(role: UserRole | null | undefined, capability: Capability): boolean {
  if (!role) return false;
  return ROLE_CAPABILITIES[role]?.includes(capability) ?? false;
}

export function capabilitiesOf(role: UserRole | null | undefined): readonly Capability[] {
  return role ? (ROLE_CAPABILITIES[role] ?? []) : [];
}

/** For UI copy: what to tell somebody who cannot do the thing. */
export const CAPABILITY_REFUSAL: Record<Capability, string> = {
  see_compensation: 'Compensation is restricted to the owner, CFO and accountant.',
  see_all_money: 'Company-wide balances are restricted.',
  move_money: 'Changing a financial figure is restricted to the owner and CFO.',
  categorise: 'Reclassifying transactions is restricted to finance roles.',
  manage_integrations: 'Bank connections are restricted to the owner and CFO.',
  manage_people: 'What a person costs is restricted to the owner and CFO.',
  manage_projects: 'Managing projects is restricted to leads and finance roles.',
  read_audit: 'The audit log is restricted to the owner, CFO and accountant.',
};

export const ROLE_LABELS: Record<UserRole, string> = {
  owner: 'Owner / CEO',
  cfo: 'CFO / Finance admin',
  accountant: 'Accountant',
  department_lead: 'Department lead',
  project_manager: 'Project manager',
  employee: 'Employee / contractor',
  viewer: 'Read-only viewer',
};
