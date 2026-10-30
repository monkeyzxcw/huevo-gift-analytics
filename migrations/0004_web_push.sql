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

CREATE TABLE IF NOT EXISTS owner_presence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  is_available INTEGER NOT NULL DEFAULT 0 CHECK (is_available IN (0, 1)),
  updated_at TEXT NOT NULL,
  updated_by_hu_user_id TEXT NOT NULL
);

INSERT OR IGNORE INTO owner_presence (id, is_available, updated_at, updated_by_hu_user_id)
VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'system');
