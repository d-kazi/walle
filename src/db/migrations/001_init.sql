-- 001: initial schema. The db is derived state, rebuildable from the JSONL log.

CREATE TABLE events (
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  chat TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  wa_msg_id TEXT,
  media_ref TEXT
);
CREATE INDEX idx_events_ts ON events (ts);
CREATE INDEX idx_events_type ON events (type, ts);

CREATE TABLE open_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  owner TEXT NOT NULL,
  child TEXT,
  due TEXT,
  source_event TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  last_nudge TEXT
);

CREATE TABLE child_time (
  date TEXT NOT NULL,
  child TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('proper', 'some', 'none')),
  reporter TEXT NOT NULL,
  PRIMARY KEY (date, child, reporter)
);

CREATE TABLE email_index (
  msg_id TEXT PRIMARY KEY,
  from_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  date TEXT NOT NULL,
  classified_as TEXT,
  action_taken TEXT
);

CREATE TABLE calendar_ops (
  id TEXT PRIMARY KEY,
  proposal_id TEXT,
  op TEXT NOT NULL,
  calendar TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts TEXT NOT NULL
);

CREATE TABLE window_state (
  user TEXT PRIMARY KEY,
  last_inbound_ts TEXT NOT NULL
);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  proposed_to TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  answered_by TEXT,
  source_event TEXT NOT NULL,
  created_ts TEXT NOT NULL,
  expiry_notified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE processed_messages (
  wa_msg_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL
);

CREATE TABLE brief_state (
  user TEXT NOT NULL,
  brief_type TEXT NOT NULL,
  last_sent_ts TEXT NOT NULL,
  PRIMARY KEY (user, brief_type)
);

CREATE TABLE midday_state (
  user TEXT NOT NULL,
  date TEXT NOT NULL,
  PRIMARY KEY (user, date)
);

CREATE TABLE unknown_senders (
  wa_id TEXT PRIMARY KEY,
  last_alert_ts TEXT
);

CREATE TABLE llm_calls (
  ts TEXT NOT NULL,
  task TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  latency_ms INTEGER,
  schema_retries INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_llm_calls_ts ON llm_calls (ts);
