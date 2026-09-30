-- migrations/0004_outbox_hardening.sql
-- Supports the lease-based outbox poller (panel review, finding P-3). Without these columns
-- the poller cannot distinguish "in flight", "retryable" and "needs a human", and its only
-- available behaviour is the at-most-once dispatch that lost jobs.

BEGIN;

ALTER TABLE outbox_event
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempts   int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS parked_at  timestamptz;

-- The poller's hot query: undispatched, unparked, due, lease-free. Partial so the index stays
-- small however large the table grows — the drained rows are the overwhelming majority.
DROP INDEX IF EXISTS outbox_pending_idx;
CREATE INDEX outbox_pending_idx ON outbox_event (available_at)
  WHERE dispatched_at IS NULL AND parked_at IS NULL;

-- Parked rows are an ops queue, not a log line. The console lists them from here.
CREATE INDEX outbox_parked_idx ON outbox_event (parked_at DESC) WHERE parked_at IS NOT NULL;

-- Retention: dispatched rows are evidence for about a fortnight, then they are noise. The
-- retention job deletes them; parked rows are never auto-deleted, because a parked
-- `errand.settled` is someone's money.
COMMENT ON COLUMN outbox_event.parked_at IS
  'Set when a row exhausted its attempts or names an unknown queue. Never auto-deleted; drain manually.';

COMMIT;
