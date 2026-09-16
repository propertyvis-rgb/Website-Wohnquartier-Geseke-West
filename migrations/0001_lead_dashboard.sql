CREATE TABLE submissions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'processed')),
  salutation TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  telephone TEXT,
  message TEXT NOT NULL,
  consent TEXT,
  source TEXT NOT NULL,
  page_url TEXT,
  extra_fields_json TEXT NOT NULL DEFAULT '{}',
  raw_payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_submissions_received_at ON submissions(received_at DESC);
CREATE INDEX idx_submissions_status_received ON submissions(status, received_at DESC);
CREATE INDEX idx_submissions_email ON submissions(email);

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_admin_sessions_expires ON admin_sessions(expires_at);

CREATE TABLE auth_attempts (
  identifier_hash TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
