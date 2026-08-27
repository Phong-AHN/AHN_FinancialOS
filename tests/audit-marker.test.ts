import { describe, expect, it } from 'vitest';
import { RULE_AUDIT_REASON, isAutomatedAudit } from '@/lib/audit';

/**
 * The recategorise pass logs its own changes and then reads the log to decide
 * which rows a person has already ruled on. Without a way to tell the two
 * apart it reads its own handwriting as a human verdict and can never revisit
 * a row — so every row the rules later learn to fix stays wrong forever.
 */
describe('automated audit entries are distinguishable from human ones', () => {
  it('recognises what the rule pass writes', () => {
    expect(isAutomatedAudit(`${RULE_AUDIT_REASON} (matched "internal-transfer")`)).toBe(true);
  });

  it('treats a human correction as human', () => {
    expect(isAutomatedAudit('Miscategorised — this is a client refund')).toBe(false);
    expect(isAutomatedAudit(null)).toBe(false);
    expect(isAutomatedAudit(undefined)).toBe(false);
    expect(isAutomatedAudit('')).toBe(false);
  });

  it('does not claim a reason that merely mentions the rules', () => {
    // Protection is the safe default: anything that is not unmistakably the
    // pass's own prefix is treated as a person's judgement.
    expect(isAutomatedAudit('Checked after we re-ran categorisation rules')).toBe(false);
  });
});
