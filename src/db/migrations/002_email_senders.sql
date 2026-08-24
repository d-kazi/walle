-- 002: senders approved (or refused) for the dedicated forwarding mailbox.
-- EMAIL_DAN and EMAIL_ALINA are always allowed and need no row here; this
-- table records only decisions a user made about an unexpected sender.

CREATE TABLE email_senders (
  address TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('allowed', 'declined')),
  ts TEXT NOT NULL
);
