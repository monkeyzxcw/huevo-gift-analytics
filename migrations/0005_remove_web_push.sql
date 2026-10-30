-- Remove retired Web Push infrastructure. Keep owner_presence, which was
-- introduced in the same historical migration but is unrelated to notifications.
DROP INDEX IF EXISTS idx_push_alert_state_user;
DROP INDEX IF EXISTS idx_push_subscriptions_user;
DROP TABLE IF EXISTS push_alert_state;
DROP TABLE IF EXISTS push_subscriptions;
DROP TABLE IF EXISTS push_vapid_keys;
