-- ============================================================================
-- Default overspend rule - Spec section 19
--
-- Split from 0017 because Postgres will not let a transaction use an enum
-- value added in that same transaction.
--
-- Idempotent: safe to re-run.
-- ============================================================================

insert into alert_rules (name, type, severity, channels, threshold_minor, threshold_number, config)
select * from (values
  ('Budget heading over',
   'budget_overspend'::alert_type, 'warning'::alert_severity,
   array['slack','email']::notification_channel[],
   null::bigint,
   -- The share of budget the PROJECTION has to reach. 1 = "on pace to finish
   -- exactly on budget is not yet a problem". Raise it to 1.1 to hear only
   -- about a projected 10% overrun.
   1::numeric,
   '{"description":"Fires once when a budget is projected to go over, and once more if it actually does. Never fires on a projection the maths cannot support."}'::jsonb)
) as v(name, type, severity, channels, threshold_minor, threshold_number, config)
where not exists (
  select 1 from alert_rules where type = 'budget_overspend'::alert_type
);
