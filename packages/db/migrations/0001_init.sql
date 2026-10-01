-- Side Qwest — PostgreSQL 16 schema
-- packages/db/migrations/0001_init.sql
-- Money is ALWAYS integer KSh cents. No numeric, no float, anywhere.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "h3";        -- h3-pg; provides the h3index type
CREATE EXTENSION IF NOT EXISTS "h3_postgis" CASCADE;  -- pulls in postgis_raster

-- ─────────────────────────────────────────────── enums

CREATE TYPE actor_role        AS ENUM ('requester','runner','staff');
CREATE TYPE errand_kind       AS ENUM ('market_run','queue_stand','document_drop','custom');
CREATE TYPE errand_status     AS ENUM (
  'draft','open','awaiting_funds','awarded','en_route','shopping',
  'awaiting_approval','handover','settled','cancelled','disputed','expired');
CREATE TYPE bid_status        AS ENUM ('sealed','won','lost','withdrawn');
CREATE TYPE stall_status      AS ENUM ('pending','photographed','approved','declined','substituted','skipped');
CREATE TYPE tranche_status    AS ENUM ('pending','loaded','failed','reversed');
CREATE TYPE attempt_rung      AS ENUM ('card','card_retry','mpesa_till','reimbursement');
CREATE TYPE attempt_result    AS ENUM ('pending','success','declined','error','timeout');
CREATE TYPE kyc_status        AS ENUM ('unsubmitted','submitted','in_review','approved','rejected','expired');
CREATE TYPE dispute_status    AS ENUM ('open','evidence','ruled','closed');
CREATE TYPE ruling_outcome    AS ENUM ('requester_favour','runner_favour','split','void');
CREATE TYPE payout_status     AS ENUM ('queued','sent','confirmed','failed');
CREATE TYPE ledger_account    AS ENUM (
  'user_wallet','escrow_hold','errand_card_float','platform_fee',
  'runner_earnings','vendor_paid','reimbursement_due','mpesa_settlement');

-- ─────────────────────────────────────────────── identity

CREATE TABLE account (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  msisdn            text NOT NULL UNIQUE,              -- E.164, +2547…
  display_name      text NOT NULL,
  role              actor_role NOT NULL,
  verification_tier smallint NOT NULL DEFAULT 0 CHECK (verification_tier BETWEEN 0 AND 3),
  language          char(2) NOT NULL DEFAULT 'en' CHECK (language IN ('en','sw')),
  suspended_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_role_tier_idx ON account (role, verification_tier) WHERE suspended_at IS NULL;

CREATE TABLE session (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  refresh_hash   text NOT NULL,
  device_label   text,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_account_idx ON session (account_id) WHERE revoked_at IS NULL;

CREATE TABLE otp_challenge (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  msisdn      text NOT NULL,
  code_hash   text NOT NULL,
  attempts    smallint NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_msisdn_idx ON otp_challenge (msisdn, created_at DESC);

-- The ONLY table holding identity documents. Encrypted columns; 7-year retention.
CREATE TABLE kyc_case (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  target_tier       smallint NOT NULL CHECK (target_tier BETWEEN 1 AND 3),
  status            kyc_status NOT NULL DEFAULT 'unsubmitted',
  id_number_enc     bytea,                             -- pgp_sym_encrypt
  id_front_key      text,                              -- R2 object key
  id_back_key       text,
  selfie_key        text,
  conduct_cert_key  text,                              -- tier 3
  next_of_kin_enc   bytea,                             -- tier 3
  movement_consent  boolean NOT NULL DEFAULT false,    -- tier 3, live location while on errand
  reviewed_by       uuid REFERENCES account(id),
  reviewed_at       timestamptz,
  reject_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kyc_queue_idx ON kyc_case (status, created_at) WHERE status IN ('submitted','in_review');

-- ─────────────────────────────────────────────── errands

CREATE TABLE errand (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id      uuid NOT NULL REFERENCES account(id),
  runner_id         uuid REFERENCES account(id),
  kind              errand_kind NOT NULL,
  status            errand_status NOT NULL DEFAULT 'draft',
  title             text NOT NULL,
  notes             text,
  pickup            geography(Point,4326),
  dropoff           geography(Point,4326) NOT NULL,
  dropoff_label     text NOT NULL,
  spend_cap_cents   bigint NOT NULL CHECK (spend_cap_cents >= 0),
  spent_cents       bigint NOT NULL DEFAULT 0 CHECK (spent_cents >= 0),
  fee_cents         bigint NOT NULL DEFAULT 0,
  deadline_at       timestamptz,
  pickup_cell       h3index,                          -- res 8, market catchment; batching key
  dropoff_cell      h3index,                          -- res 9
  bonus_cents       bigint NOT NULL DEFAULT 0,          -- on-time bonus, 5000 = KSh 50
  bonus_earned      boolean,
  awarded_bid_id    uuid,
  batch_id          uuid,
  auction_closes_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spend_within_cap CHECK (spent_cents <= spend_cap_cents)
);
CREATE INDEX errand_open_idx    ON errand (status, auction_closes_at) WHERE status = 'open';
CREATE INDEX errand_runner_idx  ON errand (runner_id, status);
CREATE INDEX errand_req_idx     ON errand (requester_id, created_at DESC);
-- The feed matches runners to the MARKET, so pickup is the hot column, not dropoff.
CREATE INDEX errand_pickup_gix  ON errand USING GIST (pickup) WHERE status = 'open';
CREATE INDEX errand_dropoff_gix ON errand USING GIST (dropoff);
CREATE INDEX errand_pickup_cell_idx ON errand (pickup_cell) WHERE status IN ('open','awarded');

-- Derive the cells on write so nothing downstream has to remember to.
CREATE OR REPLACE FUNCTION errand_set_cells() RETURNS trigger AS $$
BEGIN
  NEW.pickup_cell  := CASE WHEN NEW.pickup IS NULL THEN NULL
                           ELSE h3_lat_lng_to_cell(NEW.pickup::geometry, 8) END;
  NEW.dropoff_cell := h3_lat_lng_to_cell(NEW.dropoff::geometry, 9);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER errand_cells BEFORE INSERT OR UPDATE OF pickup, dropoff ON errand
  FOR EACH ROW EXECUTE FUNCTION errand_set_cells();

CREATE TABLE bid (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  errand_id   uuid NOT NULL REFERENCES errand(id) ON DELETE CASCADE,
  runner_id   uuid NOT NULL REFERENCES account(id),
  fee_cents   bigint NOT NULL CHECK (fee_cents > 0),
  eta_minutes smallint NOT NULL CHECK (eta_minutes > 0),
  note        text,
  status      bid_status NOT NULL DEFAULT 'sealed',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (errand_id, runner_id)                          -- one sealed bid per runner
);
CREATE INDEX bid_errand_idx ON bid (errand_id, fee_cents);

ALTER TABLE errand ADD CONSTRAINT errand_awarded_bid_fk
  FOREIGN KEY (awarded_bid_id) REFERENCES bid(id);

CREATE TABLE errand_batch (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runner_id    uuid NOT NULL REFERENCES account(id),
  planned_for  timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE errand ADD CONSTRAINT errand_batch_fk
  FOREIGN KEY (batch_id) REFERENCES errand_batch(id);

-- Written on every completed pair; drives direct invites and match ranking.
CREATE TABLE relationship (
  requester_id  uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  runner_id     uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  completed     integer NOT NULL DEFAULT 0,
  last_at       timestamptz NOT NULL DEFAULT now(),
  blocked       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (requester_id, runner_id)
);

-- ─────────────────────────────────────────────── presence

-- One current row per runner. Written only while on an errand and only with tier-3
-- movement_consent. Carries BOTH representations: the point answers "how far"
-- (ST_DWithin), the cell answers "where, roughly" (aggregation, ops reads).
CREATE TABLE runner_location (
  runner_id    uuid PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  errand_id    uuid REFERENCES errand(id) ON DELETE SET NULL,
  point        geography(Point,4326) NOT NULL,
  cell_r9      h3index NOT NULL,
  cell_r8      h3index NOT NULL,
  accuracy_m   real,
  heading_deg  real,
  battery_pct  smallint,
  is_online    boolean NOT NULL DEFAULT true,
  seq          bigint NOT NULL,                 -- monotonic per errand; blocks stale replays
  hmac_tag     bytea NOT NULL,                  -- HMAC-SHA256 over the fix, verified by the peer
  detail_enc   bytea,                           -- heading/accuracy/path sealed to the counterpart
  detail_nonce bytea,
  recorded_at  timestamptz NOT NULL,           -- device clock at capture
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (errand_id, seq)
);
CREATE INDEX runner_location_gix       ON runner_location USING GIST (point) WHERE is_online;
CREATE INDEX runner_location_cell_idx  ON runner_location (cell_r8) WHERE is_online;
CREATE INDEX runner_location_stale_idx ON runner_location (received_at);

-- Coarse history. Point retained 30 days, then nulled; the cell is kept for demand analysis.
CREATE TABLE runner_location_history (
  id          bigserial PRIMARY KEY,
  runner_id   uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  errand_id   uuid REFERENCES errand(id) ON DELETE SET NULL,
  point       geography(Point,4326),
  cell_r9     h3index NOT NULL,
  recorded_at timestamptz NOT NULL
);
CREATE INDEX rlh_runner_idx ON runner_location_history (runner_id, recorded_at DESC);
CREATE INDEX rlh_cell_idx   ON runner_location_history (cell_r9, recorded_at DESC);

CREATE OR REPLACE FUNCTION runner_location_set_cells() RETURNS trigger AS $$
BEGIN
  NEW.cell_r9 := h3_lat_lng_to_cell(NEW.point::geometry, 9);
  NEW.cell_r8 := h3_cell_to_parent(NEW.cell_r9, 8);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER runner_location_cells BEFORE INSERT OR UPDATE OF point ON runner_location
  FOR EACH ROW EXECUTE FUNCTION runner_location_set_cells();

-- ─────────────────────────────────────────────── the link handshake

-- Establishes the right for one requester and one runner to see each other's location for
-- one errand. The server holds public keys and the derived hash — never the shared secret.
-- Handover release stays with the QR token; this table has nothing to do with it.
CREATE TABLE errand_link (
  errand_id        uuid PRIMARY KEY REFERENCES errand(id) ON DELETE CASCADE,
  requester_pub    bytea NOT NULL,                  -- X25519 public key, 32 bytes
  runner_pub       bytea NOT NULL,
  link_hash        bytea NOT NULL,                  -- SHA-256(pub_R ‖ pub_N ‖ errand_id)
  requester_ack_at timestamptz,
  runner_ack_at    timestamptz,
  revoked_at       timestamptz,                     -- set at settlement; both devices wipe
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT link_hash_len CHECK (octet_length(link_hash) = 32)
);
CREATE UNIQUE INDEX errand_link_hash_idx ON errand_link (link_hash);

-- Sharing is refused until both sides have independently arrived at the same hash.
CREATE OR REPLACE VIEW errand_link_active AS
  SELECT errand_id, link_hash
    FROM errand_link
   WHERE requester_ack_at IS NOT NULL
     AND runner_ack_at IS NOT NULL
     AND revoked_at IS NULL;

-- ─────────────────────────────────────────────── basket

CREATE TABLE stall (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  errand_id     uuid NOT NULL REFERENCES errand(id) ON DELETE CASCADE,
  seq           smallint NOT NULL,
  name          text NOT NULL,
  till_number   text,                                    -- null ⇒ skip ladder rung 2
  status        stall_status NOT NULL DEFAULT 'pending',
  total_cents   bigint NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  approved_at   timestamptz,
  UNIQUE (errand_id, seq)
);

CREATE TABLE line_item (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stall_id       uuid NOT NULL REFERENCES stall(id) ON DELETE CASCADE,
  label          text NOT NULL,
  qty            numeric(8,2) NOT NULL CHECK (qty > 0),
  unit           text NOT NULL,
  price_cents    bigint CHECK (price_cents >= 0),
  substituted_for uuid REFERENCES line_item(id),
  accepted       boolean
);
CREATE INDEX line_item_stall_idx ON line_item (stall_id);

CREATE TABLE evidence (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  errand_id    uuid NOT NULL REFERENCES errand(id) ON DELETE CASCADE,
  stall_id     uuid REFERENCES stall(id) ON DELETE CASCADE,
  kind         text NOT NULL,                            -- goods | receipt | handover | sos | dispute
  object_key   text NOT NULL,
  taken_at     timestamptz NOT NULL,
  taken_at_geo geography(Point,4326),
  attempt      smallint NOT NULL DEFAULT 1 CHECK (attempt <= 2),  -- one retake only
  rejected     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_errand_idx ON evidence (errand_id, created_at);

-- ─────────────────────────────────────────────── money

CREATE TABLE card (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  errand_id      uuid NOT NULL UNIQUE REFERENCES errand(id) ON DELETE CASCADE,
  issuer_ref     text NOT NULL UNIQUE,
  last4          char(4) NOT NULL,
  loaded_cents   bigint NOT NULL DEFAULT 0 CHECK (loaded_cents >= 0),
  voided_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tranche (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id      uuid NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  stall_id     uuid NOT NULL REFERENCES stall(id),
  seq          smallint NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status       tranche_status NOT NULL DEFAULT 'pending',
  idem_key     text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (card_id, seq)
);

-- Every rung of the decline ladder leaves a row here. Ops reads this table.
CREATE TABLE card_attempt (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tranche_id    uuid NOT NULL REFERENCES tranche(id) ON DELETE CASCADE,
  rung          attempt_rung NOT NULL,
  result        attempt_result NOT NULL DEFAULT 'pending',
  provider_code text,
  provider_ref  text,
  idem_key      text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz
);
CREATE INDEX card_attempt_tranche_idx ON card_attempt (tranche_id, created_at);

-- Double entry. Postings in a group MUST sum to zero (enforced by trigger below).
CREATE TABLE posting_group (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  errand_id  uuid REFERENCES errand(id),
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE posting (
  id         bigserial PRIMARY KEY,
  group_id   uuid NOT NULL REFERENCES posting_group(id) ON DELETE CASCADE,
  account    ledger_account NOT NULL,
  owner_id   uuid REFERENCES account(id),
  amount_cents bigint NOT NULL,                          -- signed; credits negative
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX posting_owner_idx ON posting (owner_id, account, created_at DESC);
CREATE INDEX posting_group_idx ON posting (group_id);

CREATE OR REPLACE FUNCTION assert_group_balances() RETURNS trigger AS $$
DECLARE s bigint;
BEGIN
  SELECT COALESCE(sum(amount_cents),0) INTO s FROM posting WHERE group_id = NEW.group_id;
  IF s <> 0 THEN
    RAISE EXCEPTION 'posting group % does not balance: %', NEW.group_id, s;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER posting_balances
  AFTER INSERT ON posting DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_group_balances();

CREATE TABLE escrow (
  errand_id     uuid PRIMARY KEY REFERENCES errand(id) ON DELETE CASCADE,
  funded_cents  bigint NOT NULL DEFAULT 0 CHECK (funded_cents >= 0),
  held_cents    bigint NOT NULL DEFAULT 0 CHECK (held_cents >= 0),
  frozen_at     timestamptz,
  released_at   timestamptz
);

CREATE TABLE payout (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runner_id    uuid NOT NULL REFERENCES account(id),
  errand_id    uuid REFERENCES errand(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status       payout_status NOT NULL DEFAULT 'queued',
  idem_key     text NOT NULL UNIQUE,
  provider_ref text,
  failure_code text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);
CREATE INDEX payout_runner_idx ON payout (runner_id, created_at DESC);

CREATE TABLE mpesa_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direction     text NOT NULL CHECK (direction IN ('in','out')),
  merchant_ref  text UNIQUE,
  checkout_ref  text,
  msisdn        text,
  amount_cents  bigint NOT NULL,
  result_code   text,
  raw           jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────── disputes

CREATE TABLE dispute (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  errand_id    uuid NOT NULL REFERENCES errand(id),
  raised_by    uuid NOT NULL REFERENCES account(id),
  reason       text NOT NULL,
  detail       text,
  status       dispute_status NOT NULL DEFAULT 'open',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispute_queue_idx ON dispute (status, created_at);

CREATE TABLE ruling (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id     uuid NOT NULL UNIQUE REFERENCES dispute(id),
  officer_id     uuid NOT NULL REFERENCES account(id),
  outcome        ruling_outcome NOT NULL,
  requester_cents bigint NOT NULL DEFAULT 0,
  runner_cents    bigint NOT NULL DEFAULT 0,
  rationale      text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────── infrastructure tables

-- Transactional outbox: jobs are committed with their data, then drained to BullMQ.
CREATE TABLE outbox_event (
  id           bigserial PRIMARY KEY,
  queue        text NOT NULL,
  payload      jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox_event (available_at) WHERE dispatched_at IS NULL;

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  actor_id   uuid REFERENCES account(id),
  action     text NOT NULL,
  subject    text NOT NULL,
  meta       jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_subject_idx ON audit_log (subject, created_at DESC);

CREATE TABLE notification (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  channel    text NOT NULL CHECK (channel IN ('push','sms','ussd')),
  template   text NOT NULL,
  vars       jsonb NOT NULL DEFAULT '{}',
  sent_at    timestamptz,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_inbox_idx ON notification (account_id, created_at DESC);
