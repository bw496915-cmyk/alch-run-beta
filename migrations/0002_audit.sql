-- Audit trail written asynchronously by the Worker's queue() handler.
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  detail TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_at ON audit_events (at DESC);
