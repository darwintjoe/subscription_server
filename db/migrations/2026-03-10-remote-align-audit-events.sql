PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS audit_events_rebuild;
CREATE TABLE audit_events_rebuild (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  actor_user_ref TEXT,
  actor_role TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO audit_events_rebuild (id, event_type, entity_type, entity_id, actor_user_ref, actor_role, payload_json, created_at)
SELECT
  id,
  event_type,
  COALESCE(target_type, 'unknown'),
  target_id,
  actor_user_id,
  actor_role,
  payload_json,
  created_at
FROM audit_events;

DROP TABLE audit_events;
ALTER TABLE audit_events_rebuild RENAME TO audit_events;

CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at);

PRAGMA foreign_keys = ON;
