-- ============================================================================
-- Indexes for the queries that run most often
--
-- Measured from Vietnam, one round trip to the Tokyo database costs ~145ms, so
-- at today's 135 transactions the network dwarfs everything and none of these
-- change a number you can feel. They are here for the ledger AHN will actually
-- have: a sequential scan over 135 rows and over 200,000 rows look identical
-- until the day they do not.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- /integrations counts real rows per provider, once per provider, per page view.
create index if not exists idx_txn_source
  on transactions(source_system);

-- The recurring-charge detector reads three years of OUTFLOWS (spec section 8).
-- `idx_txn_date` alone makes Postgres read every row in the window and discard
-- the inflows; leading with direction lets it skip them.
create index if not exists idx_txn_direction_date
  on transactions(direction, txn_date desc);

-- Price-increase alerts ask "which rises have I already announced?" on every
-- sweep, filtered by rule and by delivery status.
create index if not exists idx_notif_rule_status
  on notifications(alert_rule_id, status);
