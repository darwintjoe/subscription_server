PRAGMA foreign_keys = ON;

-- Users and roles
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_name TEXT NOT NULL UNIQUE CHECK(role_name IN ('admin','reseller'))
);

INSERT OR IGNORE INTO roles (id, role_name) VALUES (1, 'admin'), (2, 'reseller');

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL,
  role_id INTEGER NOT NULL,
  assigned_by TEXT,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (role_id) REFERENCES roles(id),
  FOREIGN KEY (assigned_by) REFERENCES users(id)
);

-- Sessions and refresh tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Pricing is sourced from Cloudflare Worker static config (not persisted in D1).

-- Orders and payment intents
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  reseller_user_id TEXT NOT NULL,
  flow_type TEXT NOT NULL CHECK(flow_type IN ('direct_subscribe','reseller_code','bulk_printed_card')),
  country_code TEXT,
  currency TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  duration_code TEXT NOT NULL CHECK(duration_code IN ('6_months','12_months')),
  status TEXT NOT NULL CHECK(status IN ('created','pending_payment','paid','failed','canceled','fulfilled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (reseller_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS payment_intents (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('qris','card')),
  provider_ref TEXT,
  status TEXT NOT NULL CHECK(status IN ('created','pending','paid','failed','expired','canceled')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  currency TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (provider, provider_ref),
  UNIQUE (order_id, idempotency_key),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

-- Codes and redemption
CREATE TABLE IF NOT EXISTS codes (
  id TEXT PRIMARY KEY,
  code_value TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL,
  flow_type TEXT NOT NULL CHECK(flow_type IN ('direct_subscribe','reseller_code','bulk_printed_card')),
  duration_code TEXT NOT NULL CHECK(duration_code IN ('6_months','12_months')),
  status TEXT NOT NULL CHECK(status IN ('issued','reserved','redeemed','expired','canceled')),
  issued_to_user_id TEXT,
  issued_by_user_id TEXT NOT NULL,
  redeem_expires_at TEXT,
  redeemed_at TEXT,
  redeemed_by_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (issued_to_user_id) REFERENCES users(id),
  FOREIGN KEY (issued_by_user_id) REFERENCES users(id),
  FOREIGN KEY (redeemed_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS code_redemptions (
  id TEXT PRIMARY KEY,
  code_id TEXT NOT NULL UNIQUE,
  redeemed_by_user_id TEXT,
  redeemed_context TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (code_id) REFERENCES codes(id),
  FOREIGN KEY (redeemed_by_user_id) REFERENCES users(id)
);

-- Bulk batches
CREATE TABLE IF NOT EXISTS code_batches (
  id TEXT PRIMARY KEY,
  created_by_user_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  duration_code TEXT NOT NULL CHECK(duration_code IN ('6_months','12_months')),
  expiry_policy TEXT NOT NULL DEFAULT 'fixed_12_months' CHECK(expiry_policy = 'fixed_12_months'),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS code_batch_items (
  batch_id TEXT NOT NULL,
  code_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (batch_id, code_id),
  FOREIGN KEY (batch_id) REFERENCES code_batches(id),
  FOREIGN KEY (code_id) REFERENCES codes(id)
);

-- Idempotency + audit + sheet append queue
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_snapshot TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_role TEXT,
  event_type TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sheet_append_jobs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
  row_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','processing','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Basic abuse-control counters
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket_key TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_orders_reseller_created_at ON orders(reseller_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_intents_order_status ON payment_intents(order_id, status);
CREATE INDEX IF NOT EXISTS idx_codes_status_expiry ON codes(status, redeem_expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_sheet_jobs_status_created_at ON sheet_append_jobs(status, created_at);
