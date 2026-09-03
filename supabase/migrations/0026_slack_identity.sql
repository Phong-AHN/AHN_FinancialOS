-- ============================================================================
-- Linking a Slack account to an app user - Spec section 5
--
-- Slash commands need to answer "who is asking?" and Slack cannot tell us. It
-- sends a workspace user id, and workspace membership is NOT AHN's permission
-- model: contractors, agency staff and future hires all sit in the same Slack.
--
-- Without this column the only options are to answer everyone or answer nobody.
-- Answering everyone would hand the company's cash position to anyone who can
-- type a slash, straight past the roles built in 0022-0025. So a Slack id maps
-- to exactly one app user, that user's role decides what comes back, and an
-- unmapped id is refused by name.
--
-- Deliberately nullable: almost nobody will have it set, and a user without a
-- Slack link is a user who cannot use slash commands, not a broken row.
--
-- Idempotent: safe to re-run.
-- ============================================================================

alter table users add column if not exists slack_user_id text;

-- One Slack account is one person. Without this a second row could claim the
-- same id and the lookup would silently pick whichever came back first, which
-- is a way to acquire somebody else's permissions by editing your own row.
create unique index if not exists idx_users_slack_id
  on users(slack_user_id)
  where slack_user_id is not null;

comment on column users.slack_user_id is
  'Slack workspace user id (U...). Set by an owner. Null means this person cannot use slash commands.';
