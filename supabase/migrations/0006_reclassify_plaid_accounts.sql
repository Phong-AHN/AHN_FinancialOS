-- ============================================================================
-- Reclassify Plaid accounts imported under the old mapping.
--
-- Separate from 0005 because Postgres will not let a transaction use an enum
-- value that the same transaction added.
--
-- Matching on the provider's own subtype would be better, but these rows were
-- written before it was retained, so the name is what there is. New syncs
-- classify from `mapAccountType` and never reach this.
-- ============================================================================

-- Correct anything already imported under the old mapping. Matching on the
-- provider's own subtype in `raw` would be better, but these rows predate it
-- being stored, so the name is what there is.
update financial_accounts
   set type = 'loan', include_in_cash = false
 where source_system = 'plaid'
   and include_in_cash
   and (name ilike '%loan%' or name ilike '%mortgage%' or name ilike '%line of credit%');

update financial_accounts
   set type = 'investment', include_in_cash = false
 where source_system = 'plaid'
   and include_in_cash
   and (name ilike '%401k%' or name ilike '%ira%' or name ilike '%brokerage%');
