PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  picture_url TEXT,
  roles_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  access_token TEXT NOT NULL UNIQUE,
  refresh_token TEXT NOT NULL UNIQUE,
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS app_config (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  pricing_json TEXT NOT NULL,
  payment_methods_json TEXT NOT NULL,
  google_oauth_mode TEXT NOT NULL DEFAULT 'google_oauth_only',
  onboarding_rule TEXT NOT NULL DEFAULT 'first_user_admin',
  sheet_backup_enabled INTEGER NOT NULL DEFAULT 0,
  sheet_script_url TEXT,
  sheet_spreadsheet_prefix TEXT NOT NULL DEFAULT 'Subscription',
  sheet_owner_user_id TEXT,
  sheet_owner_email TEXT,
  updated_by_user_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS payment_intents (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  actor_user_ref TEXT,
  actor_role TEXT,
  actor_email TEXT,
  channel TEXT NOT NULL CHECK(channel IN ('api', 'reseller', 'admin')),
  flow_type TEXT NOT NULL CHECK(flow_type IN ('direct_subscribe','reseller_code','bulk_printed_card')),
  duration_code TEXT NOT NULL CHECK(duration_code IN ('1_day','6_months','12_months')),
  payment_method TEXT NOT NULL CHECK(payment_method IN ('qris', 'card')),
  provider TEXT NOT NULL,
  country_code TEXT,
  currency TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('created', 'pending', 'paid', 'failed', 'expired', 'canceled')),
  provider_ref TEXT,
  provider_payload_json TEXT,
  metadata_json TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  actor_user_ref TEXT,
  actor_role TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

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

CREATE INDEX IF NOT EXISTS idx_sessions_access_token ON sessions(access_token);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh_token ON sessions(refresh_token);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_payment_intents_status_created_at ON payment_intents(status, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_intents_actor_user_ref ON payment_intents(actor_user_ref);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_codes_status_expiry ON codes(status, redeem_expires_at);
CREATE INDEX IF NOT EXISTS idx_codes_payment_ref ON codes(payment_ref);
CREATE INDEX IF NOT EXISTS idx_code_batches_created_at ON code_batches(created_at);

INSERT INTO app_config (
  id,
  pricing_json,
  payment_methods_json,
  google_oauth_mode,
  onboarding_rule,
  sheet_backup_enabled,
  sheet_spreadsheet_prefix
) VALUES (
  'default',
  '{"ID":{"6_months":{"currency":"IDR","amount_minor":699000},"12_months":{"currency":"IDR","amount_minor":999000}},"VN":{"6_months":{"currency":"VND","amount_minor":699000},"12_months":{"currency":"VND","amount_minor":999000}},"TH":{"6_months":{"currency":"THB","amount_minor":1499},"12_months":{"currency":"THB","amount_minor":1999}},"MY":{"6_months":{"currency":"MYR","amount_minor":199},"12_months":{"currency":"MYR","amount_minor":299}},"MM":{"6_months":{"currency":"MMK","amount_minor":29000},"12_months":{"currency":"MMK","amount_minor":49000}},"fallback":{"6_months":{"currency":"USD","amount_minor":6900},"12_months":{"currency":"USD","amount_minor":9900}}}',
  '{"qris":{"enabled":true,"provider":"xendit"},"card":{"enabled":true,"provider":"stripe"}}',
  'google_oauth_only',
  'first_user_admin',
  0,
  'Subscription'
) ON CONFLICT(id) DO NOTHING;
