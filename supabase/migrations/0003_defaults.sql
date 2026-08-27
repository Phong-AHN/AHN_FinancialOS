-- ============================================================================
-- Default alert rules - MVP Plan section 7 (Week-1 alert spec)
-- Idempotent: safe to re-run.
-- ============================================================================

insert into alert_rules (name, type, severity, channels, threshold_minor, threshold_number, config)
select * from (values
  ('Money in - any amount',
   'money_in'::alert_type, 'info'::alert_severity,
   array['slack','email']::notification_channel[], null::bigint, null::numeric,
   '{"description":"Every inflow, no minimum. Spec 4 default alert mode."}'::jsonb),

  ('Money out - any amount',
   'money_out'::alert_type, 'info'::alert_severity,
   array['slack','email']::notification_channel[], null::bigint, null::numeric,
   '{"description":"Every outflow, no minimum. Spec 4 default alert mode."}'::jsonb),

  ('Unusually large outflow',
   'large_outflow'::alert_type, 'warning'::alert_severity,
   array['slack','email','sms']::notification_channel[], 500000::bigint, null::numeric,
   '{"description":"Single outflow above USD 5,000."}'::jsonb),

  ('Low runway',
   'low_runway'::alert_type, 'critical'::alert_severity,
   array['slack','email','sms']::notification_channel[], null::bigint, 6::numeric,
   '{"description":"Runway below 6 months."}'::jsonb),

  ('Low account balance',
   'low_balance'::alert_type, 'critical'::alert_severity,
   array['slack','email','sms']::notification_channel[], 1000000::bigint, null::numeric,
   '{"description":"Any cash account below USD 10,000."}'::jsonb),

  ('Daily CFO summary',
   'daily_summary'::alert_type, 'digest'::alert_severity,
   array['slack','email']::notification_channel[], null::bigint, null::numeric,
   '{"description":"09:00 daily digest.","schedule":"0 9 * * *"}'::jsonb),

  ('Weekly CFO summary',
   'weekly_summary'::alert_type, 'digest'::alert_severity,
   array['slack','email']::notification_channel[], null::bigint, null::numeric,
   '{"description":"Monday morning digest.","schedule":"0 9 * * 1"}'::jsonb)
) as v(name, type, severity, channels, threshold_minor, threshold_number, config)
where not exists (select 1 from alert_rules ar where ar.name = v.name);

-- A starting USD/VND rate so multi-currency rollups have something dated to
-- use on day one. Replace with a real feed in Phase 2.
insert into exchange_rates (base_currency, quote_currency, rate, as_of, source)
values ('VND', 'USD', 0.0000380, current_date, 'seed')
on conflict (base_currency, quote_currency, as_of) do nothing;

insert into exchange_rates (base_currency, quote_currency, rate, as_of, source)
values ('USD', 'USD', 1, current_date, 'seed')
on conflict (base_currency, quote_currency, as_of) do nothing;
