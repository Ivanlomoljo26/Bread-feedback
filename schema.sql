-- miden-feedback-v2 — D1 schema
-- Idempotency, triage state, issue mirror, and audit trail.

------------------------------------------------------------------------
-- SUBMISSIONS — one row per feedback submission. Idempotency layer 1.
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS submissions (
  submission_id     TEXT PRIMARY KEY,          -- client UUIDv4
  received_at       INTEGER NOT NULL,
  state             TEXT NOT NULL DEFAULT 'received',
                    -- received → claimed → publishing → published
                    -- waiting:   capped   (cap closed)
                    --            deferred (classifier down, GitHub rate
                    --                      limited, or an error with retry
                    --                      budget left)
                    --            both retried when next_attempt_at passes
                    -- terminal:  quarantined | failed
                    -- spam:      suspected_spam (awaiting human review)
                    --            spam           (confirmed by a human)
                    -- Neither appears in the drain's claim filter, so both are
                    -- non-publishing by ABSENCE rather than by a check that
                    -- could be forgotten. quarantined stays dedicated to secret
                    -- material and is never reused for spam.
                    -- A `claimed` row whose claimed_at has gone stale is
                    -- reclaimed by the drain: a dead Worker costs time, not
                    -- the report.
  body_sanitized    TEXT NOT NULL,
  body_hash         TEXT NOT NULL,             -- sha256 of raw, for dupe-payload detection
  wallet_version    TEXT,
  platform          TEXT,                      -- android | ios | extension
  network           TEXT,
  route             TEXT,
  error_code        TEXT,                      -- 12-code taxonomy, if inferable
  fingerprint       TEXT,                      -- deterministic bucket key
  reporter_key      TEXT,                      -- sha256 of the ingest limiter key; see migration 0004
  attachment_keys   TEXT,                      -- JSON array of R2 keys
  verdict           TEXT,                      -- new | duplicate | uncertain
  confidence        REAL,
  matched_issue     INTEGER,                   -- github issue number
  draft_path        TEXT,
  published_issue   INTEGER,
  published_title   TEXT,                      -- title we filed with; see migration 0003
  model_version     TEXT,                      -- for regression forensics
  prompt_version    TEXT,
  candidates        TEXT,  -- JSON array of issue numbers offered to the classifier
  quarantine_reason TEXT,

  -- Drain bookkeeping. These four reproduce, in D1, what Cloudflare Queues
  -- provided for free: retry budget, backoff, in-flight ownership, and a
  -- dead-letter destination.
  attempts          INTEGER NOT NULL DEFAULT 0,  -- spent on errors only
  next_attempt_at   INTEGER,                     -- epoch ms; NULL = now
  claimed_at        INTEGER,                     -- epoch ms of current claim
  last_error        TEXT,

  -- Spam layer; see migration 0005 for the reasoning behind each one.
  -- spam_status IS NULL means CLEAN: fail-open, so rows that predate the layer
  -- are never stranded. spam_score is telemetry and must never gate anything.
  -- spam_reasons holds reason CODES only, never quoted spam content.
  -- reporter_kind is required to tell an install_id hash from an IP hash —
  -- reporter_key alone cannot, and both rules depend on the distinction.
  spam_status       TEXT,                        -- NULL | clean | suspected | spam
  spam_score        REAL,                        -- telemetry ONLY, never a gate
  spam_reasons      TEXT,                        -- JSON array of reason CODES
  spam_reviewed_at  INTEGER,                     -- epoch ms of the human decision
  spam_reviewed_by  TEXT,                        -- verified reviewer identity
  normalized_hash   TEXT,                        -- flood key; src/lib/spam-signals.ts
  reporter_kind     TEXT,                        -- 'install' | 'ip'
  -- Which overdue tier has already been announced for this row. Per-row rather
  -- than a high-water cursor: reports do not become suspected in arrival order,
  -- so a cursor silently skips one flagged long after it was received. See
  -- migration 0006.
  overdue_alert_tier TEXT                        -- NULL | warn | escalate
);
CREATE INDEX IF NOT EXISTS idx_sub_state       ON submissions(state);
-- The drain's claim query filters on exactly this pair.
CREATE INDEX IF NOT EXISTS idx_sub_pending     ON submissions(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_sub_fingerprint ON submissions(fingerprint);
-- The per-reporter publish gate counts a reporter's issues over 1h and 24h.
CREATE INDEX IF NOT EXISTS idx_sub_reporter     ON submissions(reporter_key);
CREATE INDEX IF NOT EXISTS idx_sub_received    ON submissions(received_at);
CREATE INDEX IF NOT EXISTS idx_sub_body_hash   ON submissions(body_hash);
-- The review queue lists by verdict, oldest first; the overdue check counts
-- unreviewed rows past a deadline. Both filter on exactly this pair.
CREATE INDEX IF NOT EXISTS idx_sub_spam       ON submissions(spam_status, received_at);
-- The flood check counts one reporter's identical submissions inside a window.
CREATE INDEX IF NOT EXISTS idx_sub_flood      ON submissions(reporter_key, normalized_hash, received_at);
-- The overdue-alert query filters on exactly this triple.
CREATE INDEX IF NOT EXISTS idx_sub_overdue    ON submissions(state, overdue_alert_tier, spam_reviewed_at);

------------------------------------------------------------------------
-- STATE_LOG — append-only audit. Never UPDATE, only INSERT.
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS state_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL,
  at            INTEGER NOT NULL,
  from_state    TEXT,
  to_state      TEXT NOT NULL,
  detail        TEXT,
  FOREIGN KEY (submission_id) REFERENCES submissions(submission_id)
);
CREATE INDEX IF NOT EXISTS idx_log_sub ON state_log(submission_id, at);

------------------------------------------------------------------------
-- ISSUE_MIRROR — local copy of 0xMiden/wallet issues. Read-only source.
-- Includes v1-relay and human-filed issues; all are valid dedup targets.
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS issue_mirror (
  number        INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  body          TEXT,
  state         TEXT NOT NULL,                 -- open | closed
  labels        TEXT,                          -- JSON array
  author        TEXT,
  created_at    INTEGER,
  updated_at    INTEGER,
  marker        TEXT,                          -- extracted mfv2/v1 submission id, if any
  embedding     BLOB,                          -- optional local vector
  synced_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mirror_state   ON issue_mirror(state);
CREATE INDEX IF NOT EXISTS idx_mirror_updated ON issue_mirror(updated_at);
CREATE INDEX IF NOT EXISTS idx_mirror_marker  ON issue_mirror(marker);

------------------------------------------------------------------------
-- DUP_LINKS — which submissions were COMMENTED onto which issue. A closed
-- match is not folded and gets no row here; /status reads this table to
-- decide whether to tell a reporter their report was merged.
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dup_links (
  submission_id TEXT NOT NULL,
  issue_number  INTEGER NOT NULL,
  confidence    REAL,
  linked_at     INTEGER NOT NULL,
  PRIMARY KEY (submission_id, issue_number)
);
CREATE INDEX IF NOT EXISTS idx_dup_issue ON dup_links(issue_number);

------------------------------------------------------------------------
-- SYNC_STATE — cursors and ETags for the mirror.
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  at    INTEGER NOT NULL
);
