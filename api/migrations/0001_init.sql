-- One row per completed quiz. No IPs, accounts or cookies.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  model TEXT NOT NULL,
  first_language TEXT -- 'yes', 'no', or NULL (skipped)
);

-- One row per round.
CREATE TABLE answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  created_at TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  choice INTEGER NOT NULL,   -- index of the option picked (4 = too hard); correctness is computed later from the repo
  read_ms INTEGER NOT NULL,
  words INTEGER NOT NULL,
  round INTEGER NOT NULL,
  guess INTEGER NOT NULL,    -- 1 = question shown without a summary
  hidden INTEGER NOT NULL    -- 1 = tab was hidden while reading
);
CREATE INDEX answers_model ON answers(model, created_at);

-- Rate limiting: salted hash of IP + hour. Rows older than two hours are deleted.
CREATE TABLE rate (
  key TEXT PRIMARY KEY,
  hour INTEGER NOT NULL,
  n INTEGER NOT NULL
);
