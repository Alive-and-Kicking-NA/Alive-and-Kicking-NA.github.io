CREATE TABLE attendees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  code_hash TEXT NOT NULL UNIQUE,
  downloads_left INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  speaker TEXT,
  r2_key TEXT NOT NULL,
  size INTEGER,
  sort INTEGER NOT NULL DEFAULT 0
);

-- A ticket is a short-lived, per-download URL token. Creating one spends one download.
-- Rows are kept as a download log.
CREATE TABLE tickets (
  token TEXT PRIMARY KEY,
  attendee_id INTEGER NOT NULL,
  recording_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL COLLATE NOCASE,
  token TEXT NOT NULL UNIQUE,
  ip TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | denied
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE attempts (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_attempts ON attempts(ip, at);
CREATE INDEX idx_requests_ip ON requests(ip, created_at);
