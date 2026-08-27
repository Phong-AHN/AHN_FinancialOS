-- ============================================================================
-- Notifications outlive the transaction they announced.
--
-- `notifications.transaction_id` was ON DELETE CASCADE, which means deleting a
-- transaction silently erased the record that we alerted someone about it.
--
-- That is wrong for two reasons:
--
--   1. Plaid removes a transaction when the bank reverses it, and the sync
--      deletes the row to keep cash honest. Under CASCADE, the fact that the CEO
--      was paged about that money vanished with it - so the alert log disagreed
--      with what people actually received.
--
--   2. The Day-4 end-to-end test creates a transaction, lets it fire a real
--      alert, and removes it again. The proof of delivery has to survive.
--
-- SET NULL keeps the notification, with its title and body intact, and simply
-- drops the link. Spec section 24 is about not being able to erase the record of
-- what happened; this closes the same gap for alert delivery.
-- ============================================================================

alter table notifications
  drop constraint if exists notifications_transaction_id_fkey;

alter table notifications
  add constraint notifications_transaction_id_fkey
  foreign key (transaction_id) references transactions(id) on delete set null;

-- The transaction may be gone, but which account and counterparty it concerned
-- should still be readable from the log.
alter table notifications
  add column if not exists context jsonb not null default '{}'::jsonb;

comment on column notifications.context is
  'Snapshot of the transaction at alert time (account, counterparty, amount), so the log stays readable after the row is deleted.';
