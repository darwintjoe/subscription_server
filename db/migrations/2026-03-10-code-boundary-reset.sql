PRAGMA foreign_keys = OFF;

DROP INDEX IF EXISTS idx_codes_payment_ref;
DROP INDEX IF EXISTS idx_code_batches_created_at;
DROP INDEX IF EXISTS idx_codes_status_expiry;

DROP TABLE IF EXISTS code_batch_items;
DROP TABLE IF EXISTS code_redemptions;
DROP TABLE IF EXISTS code_batches;
DROP TABLE IF EXISTS codes;

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS codes (
  id TEXT PRIMARY KEY,
  code_value TEXT NOT NULL UNIQUE,
  flow_type TEXT NOT NULL CHECK(flow_type IN ('direct_subscribe','reseller_code','bulk_printed_card')),
  duration_code TEXT NOT NULL CHECK(duration_code IN ('6_months','12_months')),
  status TEXT NOT NULL CHECK(status IN ('issued','reserved','redeemed','expired','canceled')),
  payment_ref TEXT,
  issued_to_user_ref TEXT,
  issued_by_user_ref TEXT,
  redeem_expires_at TEXT,
  redeemed_at TEXT,
  redeemed_by_user_ref TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS code_redemptions (
  id TEXT PRIMARY KEY,
  code_id TEXT NOT NULL UNIQUE,
  redeemed_by_user_ref TEXT,
  redeemed_context TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (code_id) REFERENCES codes(id)
);

CREATE TABLE IF NOT EXISTS code_batches (
  id TEXT PRIMARY KEY,
  created_by_user_ref TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  duration_code TEXT NOT NULL CHECK(duration_code IN ('6_months','12_months')),
  expiry_policy TEXT NOT NULL DEFAULT 'fixed_12_months' CHECK(expiry_policy = 'fixed_12_months'),
  notes TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS code_batch_items (
  batch_id TEXT NOT NULL,
  code_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (batch_id, code_id),
  FOREIGN KEY (batch_id) REFERENCES code_batches(id),
  FOREIGN KEY (code_id) REFERENCES codes(id)
);

CREATE INDEX IF NOT EXISTS idx_codes_status_expiry ON codes(status, redeem_expires_at);
CREATE INDEX IF NOT EXISTS idx_codes_payment_ref ON codes(payment_ref);
CREATE INDEX IF NOT EXISTS idx_code_batches_created_at ON code_batches(created_at);
