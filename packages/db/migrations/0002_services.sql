-- Side Qwest — schema v2
-- packages/db/migrations/0002_services.sql
-- Forward-only. Adds assignment modes, funding modes, two-sided fees, checkpoints/ETA,
-- payment rails, and the per-service event plumbing. Nothing here edits 0001.
-- migrate:autocommit — ALTER TYPE ... ADD VALUE must commit before the partial index below
-- can reference the new value, so this file runs statement by statement.

-- ─────────────────────────────────────────────── enums

CREATE TYPE assignment_mode AS ENUM ('pick','open');
CREATE TYPE funding_mode    AS ENUM ('upfront','tranche');
CREATE TYPE payment_rail    AS ENUM ('mpesa_stk','mpesa_paybill','bank_transfer','card','wallet');
CREATE TYPE payment_status  AS ENUM ('initiated','pending','confirmed','failed','expired');
CREATE TYPE checkpoint_kind AS ENUM (
  'assigned','en_route','arrived','stall_submitted','stall_approved','handover');
CREATE TYPE eta_confidence  AS ENUM ('high','medium','low');

ALTER TYPE errand_status ADD VALUE IF NOT EXISTS 'offered' BEFORE 'awarded';
ALTER TYPE ledger_account ADD VALUE IF NOT EXISTS 'service_fee_requester';
ALTER TYPE ledger_account ADD VALUE IF NOT EXISTS 'maintenance_fee_runner';

-- ─────────────────────────────────────────────── assignment

ALTER TABLE errand
  ADD COLUMN assignment_mode assignment_mode NOT NULL DEFAULT 'pick',
  ADD COLUMN funding_mode    funding_mode    NOT NULL DEFAULT 'tranche',
  ADD COLUMN offered_to      uuid REFERENCES account(id),
  ADD COLUMN offered_at      timestamptz,
  ADD COLUMN offer_expires_at timestamptz,
  ADD COLUMN assigned_at     timestamptz,
  ADD COLUMN agreed_fee_cents bigint CHECK (agreed_fee_cents >= 0);

-- Market runs load per stall; everything else loads the agreed amount at assignment.
UPDATE errand SET funding_mode = (CASE WHEN kind = 'market_run' THEN 'tranche' ELSE 'upfront' END)::funding_mode;

-- First-write-wins depends on this partial index staying selective.
CREATE INDEX errand_claimable_idx ON errand (status, assignment_mode)
  WHERE runner_id IS NULL AND status IN ('open','offered');
CREATE INDEX errand_offer_expiry_idx ON errand (offer_expires_at)
  WHERE offered_to IS NOT NULL AND runner_id IS NULL;

-- Every offer, accepted or not. Feeds acceptance-rate stats and the ops trace.
CREATE TABLE errand_offer (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  errand_id   uuid NOT NULL REFERENCES errand(id) ON DELETE CASCADE,
  runner_id   uuid NOT NULL REFERENCES account(id),
  fee_cents   bigint NOT NULL CHECK (fee_cents > 0),
  outcome     text NOT NULL DEFAULT 'pending'
              CHECK (outcome IN ('pending','accepted','declined','lapsed','withdrawn')),
  offered_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  resolved_at timestamptz
);
CREATE INDEX errand_offer_pending_idx ON errand_offer (expires_at) WHERE outcome = 'pending';
CREATE INDEX errand_offer_runner_idx  ON errand_offer (runner_id, offered_at DESC);

-- ─────────────────────────────────────────────── pricing

-- Both halves of the 12% are recorded explicitly. Never re-derive a fee from a percentage
-- at read time; the rate can change and history must not.
CREATE TABLE errand_fee (
  errand_id            uuid PRIMARY KEY REFERENCES errand(id) ON DELETE CASCADE,
  base_cents           bigint NOT NULL CHECK (base_cents >= 0),   -- the agreed runner fee
  rate_bps             integer NOT NULL,                          -- total take, e.g. 1200
  requester_fee_cents  bigint NOT NULL CHECK (requester_fee_cents >= 0),
  runner_fee_cents     bigint NOT NULL CHECK (runner_fee_cents >= 0),
  requester_charged_at timestamptz,                               -- at deposit
  runner_deducted_at   timestamptz,                               -- at disbursement
  computed_at          timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────── payments

CREATE TABLE payment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES account(id),
  errand_id     uuid REFERENCES errand(id),
  rail          payment_rail NOT NULL,
  direction     text NOT NULL CHECK (direction IN ('in','out')),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  fee_cents     bigint NOT NULL DEFAULT 0,        -- the requester's half, when direction='in'
  status        payment_status NOT NULL DEFAULT 'initiated',
  idem_key      text NOT NULL UNIQUE,
  provider      text NOT NULL,
  provider_ref  text,
  failure_code  text,
  expires_at    timestamptz,                      -- bank transfers can sit for a day
  created_at    timestamptz NOT NULL DEFAULT now(),
  confirmed_at  timestamptz
);
CREATE INDEX payment_account_idx ON payment (account_id, created_at DESC);
CREATE INDEX payment_pending_idx ON payment (status, created_at) WHERE status IN ('initiated','pending');
CREATE UNIQUE INDEX payment_provider_ref_idx ON payment (provider, provider_ref)
  WHERE provider_ref IS NOT NULL;

-- ─────────────────────────────────────────────── progress and ETA

CREATE TABLE errand_checkpoint (
  id          bigserial PRIMARY KEY,
  errand_id   uuid NOT NULL REFERENCES errand(id) ON DELETE CASCADE,
  kind        checkpoint_kind NOT NULL,
  stall_id    uuid REFERENCES stall(id) ON DELETE CASCADE,
  reached_at  timestamptz NOT NULL,
  cell_r8     h3index,
  UNIQUE (errand_id, kind, stall_id)
);
CREATE INDEX checkpoint_errand_idx ON errand_checkpoint (errand_id, reached_at);

-- Learned medians. Falls back to the global row (cell_r8 IS NULL) under 20 samples.
CREATE TABLE checkpoint_duration (
  kind         checkpoint_kind NOT NULL,
  errand_kind  errand_kind NOT NULL,
  cell_r8      h3index,
  hour_bucket  smallint CHECK (hour_bucket BETWEEN 0 AND 23),
  median_secs  integer NOT NULL CHECK (median_secs >= 0),
  p90_secs     integer NOT NULL,
  samples      integer NOT NULL DEFAULT 0,
  is_seed      boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, errand_kind, cell_r8, hour_bucket)
);

CREATE TABLE errand_eta (
  errand_id        uuid PRIMARY KEY REFERENCES errand(id) ON DELETE CASCADE,
  percent_complete smallint NOT NULL CHECK (percent_complete BETWEEN 0 AND 100),
  eta_at           timestamptz,
  eta_low_at       timestamptz,
  eta_high_at      timestamptz,
  confidence       eta_confidence NOT NULL,
  stale_since      timestamptz,
  computed_at      timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────── per-service event plumbing

-- Each service owns its own copy of these two in its own schema. Shown once here.
-- outbox_event already exists from 0001; this is the consumer side.
CREATE TABLE consumed_event (
  event_id    uuid PRIMARY KEY,
  consumer    text NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consumed_event_consumer_idx ON consumed_event (consumer, consumed_at DESC);

ALTER TABLE outbox_event
  ADD COLUMN event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN version  smallint NOT NULL DEFAULT 1,
  ADD COLUMN actor_id uuid,
  ADD COLUMN errand_id uuid;
CREATE UNIQUE INDEX outbox_event_id_idx ON outbox_event (event_id);
