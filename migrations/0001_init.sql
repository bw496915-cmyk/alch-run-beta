-- Applied by alchemy on deploy (D1.Database migrations prop).
CREATE TABLE IF NOT EXISTS photos (
  key TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS photos_created_at ON photos (created_at DESC);
