-- ============================================================================
-- Default receivable and obligation rules - Spec sections 17 and 18
--
-- Split from 0020: Postgres will not let a transaction use an enum value added
-- in that same transaction.
--
-- Idempotent: safe to re-run.
-- ============================================================================

insert into alert_rules (name, type, severity, channels, threshold_minor, threshold_number, config)
select * from (values
  ('Overdue invoice',
   'overdue_receivable'::alert_type, 'warning'::alert_severity,
   array['slack','email']::notification_channel[],
   -- Below USD 100 the chase costs more than the debt.
   10000::bigint, null::numeric,
   '{"description":"Fires once per invoice per aging bucket. Crossing 30 days into 60 is news; the days in between are the same fact repeated."}'::jsonb),

  ('Large commitment due soon',
   'upcoming_obligation'::alert_type, 'info'::alert_severity,
   array['slack','email']::notification_channel[],
   -- USD 1,000 or more, inside a fortnight.
   100000::bigint, null::numeric,
   '{"description":"Money about to leave, or arrive, in the next 14 days. Fires once per item."}'::jsonb)
) as v(name, type, severity, channels, threshold_minor, threshold_number, config)
where not exists (
  select 1 from alert_rules
  where alert_rules.type in ('overdue_receivable'::alert_type, 'upcoming_obligation'::alert_type)
);
