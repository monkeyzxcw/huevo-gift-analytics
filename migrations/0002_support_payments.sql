CREATE TABLE IF NOT EXISTS support_payments (
  intent_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 100000),
  test INTEGER NOT NULL DEFAULT 1 CHECK (test IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled', 'expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_support_payments_status_test
  ON support_payments (status, test);

CREATE INDEX IF NOT EXISTS idx_support_payments_created_at
  ON support_payments (created_at);
