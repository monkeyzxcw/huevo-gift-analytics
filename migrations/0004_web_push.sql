CREATE TABLE IF NOT EXISTS push_vapid_keys (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_key TEXT NOT NULL,
  private_jwk TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user_accounts(user_id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth_secret TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS push_alert_state (
  user_id TEXT NOT NULL REFERENCES user_accounts(user_id) ON DELETE CASCADE,
  lot_id TEXT NOT NULL,
  target_price INTEGER NOT NULL,
  alerted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, lot_id)
);

CREATE INDEX IF NOT EXISTS idx_push_alert_state_user
  ON push_alert_state (user_id);
