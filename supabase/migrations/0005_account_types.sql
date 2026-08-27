-- ============================================================================
-- Loans and investments are not cash.
--
-- Plaid returns six account types: depository, credit, loan, investment,
-- brokerage, other. Everything outside depository/credit was being mapped to
-- `other`, and `other` counted toward cash - so a mortgage, a student loan, an
-- auto loan, a HELOC, a 401k and an IRA all landed in the figure that answers
-- "how much cash do we have?".
--
-- Loans make it worse than a rounding error: Plaid reports the balance OWED as
-- a POSITIVE number, so debt inflated cash. A sandbox connection alone added
-- $182,228 of borrowings and locked-up investments to the headline.
--
-- These two enum values let the account carry what it actually is, so the
-- Accounts page can say "Mortgage" instead of "Other" and the cash rule follows
-- from the type rather than from a flag someone has to remember to set.
-- ============================================================================

do $types$ begin
  alter type account_type add value if not exists 'loan';
exception when duplicate_object then null; end $types$;

do $types$ begin
  alter type account_type add value if not exists 'investment';
exception when duplicate_object then null; end $types$;

-- The reclassification of already-imported rows lives in 0006. Postgres refuses
-- to USE an enum value in the same transaction that ADDED it ("unsafe use of
-- new value"), and the migration runner sends each file as one statement.
