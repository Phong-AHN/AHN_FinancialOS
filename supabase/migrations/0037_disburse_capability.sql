-- ============================================================================
-- A separate capability for money actually leaving - Spec section 23
--
-- `can_move_money()` has meant "may change financial records" since migration
-- 0023: set an exchange rate, edit a budget, reclassify a payment. Every one of
-- those is reversible by another edit.
--
-- Sending payroll is not. Reusing the same capability would have silently
-- granted disbursement to everybody who could already correct a typo, and the
-- name would have stopped describing what it does - which is how a permission
-- model rots.
--
-- Owner and CFO. Deliberately no wider: migration 0036 requires the approver to
-- be somebody other than the preparer, so AHN needs at least two people holding
-- this before a single payment can be sent. That is the intended cost.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create or replace function can_disburse() returns boolean
language sql stable as $fn$
  select app_user_role() in ('owner', 'cfo');
$fn$;

comment on function can_disburse() is
  'Spec 23. May cause money to LEAVE the company. Distinct from can_move_money(), which is about editing records.';

-- Tighten the payroll tables onto it. 0036 created them under can_move_money();
-- an accountant may correct a payment record but may not send one.
drop policy if exists p_payroll_runs_write on payroll_runs;
create policy p_payroll_runs_write on payroll_runs for all
  using (can_disburse()) with check (can_disburse());

drop policy if exists p_payroll_payments_write on payroll_payments;
create policy p_payroll_payments_write on payroll_payments for all
  using (can_disburse()) with check (can_disburse());
