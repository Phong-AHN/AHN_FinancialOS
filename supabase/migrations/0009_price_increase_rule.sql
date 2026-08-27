-- ============================================================================
-- Default price-increase rule - Spec section 8
--
-- Split from 0008 because Postgres will not let a transaction use an enum
-- value added in that same transaction. The type has to be committed first.
--
-- Idempotent: safe to re-run.
-- ============================================================================

insert into alert_rules (name, type, severity, channels, threshold_minor, threshold_number, config)
select * from (values
  ('Subscription price increase',
   'price_increase'::alert_type, 'warning'::alert_severity,
   array['slack','email']::notification_channel[],
   -- Floors, and BOTH must be cleared. A 40% rise on a $4 tool is noise; a 3%
   -- rise on a $70k payroll bill is not a price change anyone chose. Together
   -- they select the rises worth interrupting someone about.
   5000::bigint,   -- at least USD 50 a year of extra cost
   0.10::numeric,  -- at least a 10% rise
   '{"description":"A recurring charge started billing more. Fires once per vendor per price change, never on a schedule."}'::jsonb)
) as v(name, type, severity, channels, threshold_minor, threshold_number, config)
where not exists (
  select 1 from alert_rules where type = 'price_increase'::alert_type
);
