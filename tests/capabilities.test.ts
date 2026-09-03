import { describe, expect, it } from 'vitest';
import { ROLE_LABELS, can, capabilitiesOf } from '@/lib/capabilities';
import type { UserRole } from '@/lib/types';

const ROLES: UserRole[] = [
  'owner',
  'cfo',
  'accountant',
  'department_lead',
  'project_manager',
  'employee',
  'viewer',
];

describe('the role matrix', () => {
  it('covers all seven roles spec §23 names', () => {
    for (const role of ROLES) {
      expect(ROLE_LABELS[role], role).toBeTruthy();
      expect(Array.isArray(capabilitiesOf(role)), role).toBe(true);
    }
  });

  it('keeps bank credentials to the owner and CFO', () => {
    // The narrowest capability in the system: these are live access to AHN's
    // money, not a report about it.
    expect(can('owner', 'manage_integrations')).toBe(true);
    expect(can('cfo', 'manage_integrations')).toBe(true);
    for (const role of ['accountant', 'department_lead', 'project_manager', 'employee', 'viewer'] as UserRole[]) {
      expect(can(role, 'manage_integrations'), role).toBe(false);
    }
  });

  it('lets an accountant reclassify but not move money', () => {
    // Reclassifying a payment is their job. Connecting a bank account, setting
    // an exchange rate and changing what a person costs are not.
    expect(can('accountant', 'categorise')).toBe(true);
    expect(can('accountant', 'move_money')).toBe(false);
    expect(can('accountant', 'manage_people')).toBe(false);
    expect(can('accountant', 'manage_integrations')).toBe(false);
  });

  it('keeps compensation to the three finance roles', () => {
    for (const role of ['owner', 'cfo', 'accountant'] as UserRole[]) {
      expect(can(role, 'see_compensation'), role).toBe(true);
    }
    for (const role of ['department_lead', 'project_manager', 'employee', 'viewer'] as UserRole[]) {
      expect(can(role, 'see_compensation'), role).toBe(false);
    }
  });

  it('gives a scoped role LESS than a viewer, not a subset of the owner', () => {
    // A viewer is trusted with the whole picture minus compensation. A
    // department lead is trusted with their unit. Those are different axes,
    // and treating a lead as a lesser owner would hand them the company.
    expect(can('viewer', 'see_all_money')).toBe(true);
    expect(can('department_lead', 'see_all_money')).toBe(false);
    expect(can('project_manager', 'see_all_money')).toBe(false);
    expect(can('employee', 'see_all_money')).toBe(false);
  });

  it('gives an employee nothing company-wide at all', () => {
    expect(capabilitiesOf('employee')).toHaveLength(0);
  });

  it('never grants a capability to a role that has none', () => {
    const capabilities = [
      'see_compensation',
      'see_all_money',
      'move_money',
      'categorise',
      'manage_integrations',
      'manage_people',
      'manage_projects',
      'read_audit',
    ] as const;
    for (const c of capabilities) {
      expect(can('project_manager', c), c).toBe(false);
      expect(can('employee', c), c).toBe(false);
    }
  });

  it('treats a missing role as no capability at all', () => {
    expect(can(null, 'see_all_money')).toBe(false);
    expect(can(undefined, 'move_money')).toBe(false);
  });
});
