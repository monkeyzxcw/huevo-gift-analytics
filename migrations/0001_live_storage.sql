CREATE TABLE IF NOT EXISTS full_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data_json TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS live_page_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  items_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  last_poll_at TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS live_price_history (
  lot_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  price REAL NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (lot_id, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_live_price_history_observed_at
  ON live_price_history (observed_at);

CREATE INDEX IF NOT EXISTS idx_live_price_history_lot_time
  ON live_price_history (lot_id, observed_at);
