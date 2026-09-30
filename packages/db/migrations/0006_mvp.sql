-- migrations/0006_mvp.sql
-- What the first running build of the API and worker needed that 0001–0005 did not provide,
-- and the RLS defects that only showed up once real handlers ran as sidequest_app.
--
-- Grouped by cause. Every change states the failure it prevents.

BEGIN;

-- ─────────────────────────────────────────────── 1. definer role
--
-- app_is_party() and friends are SECURITY DEFINER so a policy on one table can consult
-- `errand` without recursing through errand's own policies. They ran as whoever applied the
-- migration. In dev and CI that is a superuser, which bypasses RLS, so every test passed. In
-- production the owner is a non-superuser subject to FORCE RLS with no policy of its own, so
-- the helpers would read zero rows and every party check in the system would return false.
--
-- A dedicated NOLOGIN role owns the helpers and the ledger trigger functions, with read-only
-- policies on exactly the tables they consult. No BYPASSRLS anywhere.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sidequest_definer') THEN
    CREATE ROLE sidequest_definer NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO sidequest_definer;
GRANT SELECT ON errand, posting, posting_group, stall TO sidequest_definer;
CREATE POLICY definer_read_errand   ON errand        FOR SELECT TO sidequest_definer USING (true);
CREATE POLICY definer_read_posting  ON posting       FOR SELECT TO sidequest_definer USING (true);
CREATE POLICY definer_read_pgroup   ON posting_group FOR SELECT TO sidequest_definer USING (true);
CREATE POLICY definer_read_stall    ON stall         FOR SELECT TO sidequest_definer USING (true);

ALTER FUNCTION app_is_party(uuid)     OWNER TO sidequest_definer;
ALTER FUNCTION app_is_requester(uuid) OWNER TO sidequest_definer;
ALTER FUNCTION app_is_runner(uuid)    OWNER TO sidequest_definer;

-- The balance and currency triggers summed postings AS THE INVOKER, so under RLS they saw
-- only the rows the caller may read. A requester's approval would have been checked against
-- a partial group. They must see the whole group.
ALTER FUNCTION assert_group_balances()        SECURITY DEFINER SET search_path = public;
ALTER FUNCTION assert_group_single_currency() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION assert_errand_currency()       SECURITY DEFINER SET search_path = public;
ALTER FUNCTION assert_group_balances()        OWNER TO sidequest_definer;
ALTER FUNCTION assert_group_single_currency() OWNER TO sidequest_definer;
ALTER FUNCTION assert_errand_currency()       OWNER TO sidequest_definer;

-- ─────────────────────────────────────────────── 2. ledger append-only (RLS gate failure)
--
-- 0003 granted SELECT, INSERT, UPDATE on posting to sidequest_worker in a bulk GRANT, which
-- contradicts its own comment two screens later. The RLS gate caught it.
REVOKE UPDATE, DELETE ON posting FROM sidequest_worker;

-- ─────────────────────────────────────────────── 3. tables with no RLS (RLS gate failure)

ALTER TABLE checkpoint_duration ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkpoint_duration FORCE ROW LEVEL SECURITY;
GRANT SELECT ON checkpoint_duration TO sidequest_app, sidequest_worker, sidequest_ops;
GRANT INSERT, UPDATE ON checkpoint_duration TO sidequest_worker;
-- Medians are aggregate and carry no per-actor data; every signed-in actor may read them.
CREATE POLICY cpd_read   ON checkpoint_duration FOR SELECT TO sidequest_app USING (app_actor() IS NOT NULL);
CREATE POLICY cpd_ops    ON checkpoint_duration FOR SELECT TO sidequest_ops USING (app_has_ent('ops.read'));
CREATE POLICY cpd_worker ON checkpoint_duration FOR ALL TO sidequest_worker USING (true) WITH CHECK (true);

ALTER TABLE fx_conversion ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_conversion FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON fx_conversion TO sidequest_worker;
GRANT SELECT ON fx_conversion TO sidequest_ops;
CREATE POLICY fx_worker ON fx_conversion FOR ALL TO sidequest_worker USING (true) WITH CHECK (true);
CREATE POLICY fx_ops    ON fx_conversion FOR SELECT TO sidequest_ops USING (app_has_ent('ledger.read'));

-- ─────────────────────────────────────────────── 4. identity

-- Staff grants live on the account, and only ops can change them.
ALTER TABLE account ADD COLUMN staff_grants text[] NOT NULL DEFAULT '{}';

-- Column-level grants. 0003 gave the app role UPDATE on every column of its own row, which
-- included verification_tier: one crafted PATCH and a tier-0 account is tier 3. And SELECT
-- on every column of every counterparty row, which included msisdn — the column 0003's own
-- comment says a counterparty must never see.
REVOKE SELECT, UPDATE ON account FROM sidequest_app;
GRANT SELECT (id, display_name, role, verification_tier, language, market, suspended_at,
              staff_grants, created_at, updated_at) ON account TO sidequest_app;
GRANT UPDATE (display_name, language, role, updated_at) ON account TO sidequest_app;
GRANT INSERT (msisdn, display_name, role, verification_tier, language, market) ON account TO sidequest_app;

-- Role switching is self-service between requester and runner. Staff is never self-granted.
DROP POLICY account_self_update ON account;
CREATE POLICY account_self_update ON account FOR UPDATE TO sidequest_app
  USING (id = app_actor()) WITH CHECK (id = app_actor() AND role <> 'staff');

-- Sign-in. Pre-authentication there is no actor, so the account is found through a
-- purpose-scoped GUC that the OTP handler sets only after the code has been verified, in the
-- same transaction. The handler selects `id` with no WHERE on msisdn at all: the policy is
-- the filter, so the app role never needs SELECT on the msisdn column.
CREATE POLICY account_login ON account FOR SELECT TO sidequest_app
  USING (msisdn = nullif(current_setting('app.login_msisdn', true), ''));
CREATE POLICY account_signup ON account FOR INSERT TO sidequest_app
  WITH CHECK (msisdn = nullif(current_setting('app.login_msisdn', true), '')
              AND role IN ('requester', 'runner')
              AND verification_tier = 1);

-- Discovery reads display names of verified runners, and nothing else, under the same
-- purpose-scoped GUC that already gates runner_location.
CREATE POLICY account_discovery ON account FOR SELECT TO sidequest_app
  USING (current_setting('app.discovery', true) = 'on' AND role = 'runner' AND verification_tier >= 3);

-- The refresh token rotates inside a family; reuse of a spent token revokes the family.
ALTER TABLE session
  ADD COLUMN family_id   uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN device_id   text,
  ADD COLUMN rotated_at  timestamptz,
  ADD COLUMN last_country char(2);
CREATE INDEX session_family_idx ON session (family_id);
-- The refresh call has only the token, not the actor. Same pattern as sign-in: the handler
-- sets a GUC to the presented token's hash and the policy is the lookup.
CREATE POLICY session_refresh ON session FOR SELECT TO sidequest_app
  USING (refresh_hash = nullif(current_setting('app.refresh_hash', true), ''));
CREATE POLICY session_family_revoke ON session FOR UPDATE TO sidequest_app
  USING (family_id::text = nullif(current_setting('app.session_family', true), ''))
  WITH CHECK (family_id::text = nullif(current_setting('app.session_family', true), ''));

-- KYC: the subject fills in and submits their own case. They could not before — 0003 granted
-- SELECT and INSERT only, so no document key could ever be attached.
GRANT UPDATE (id_number_enc, id_front_key, id_back_key, selfie_key, conduct_cert_key,
              next_of_kin_enc, movement_consent, status) ON kyc_case TO sidequest_app;
CREATE POLICY kyc_self_update ON kyc_case FOR UPDATE TO sidequest_app
  USING (account_id = app_actor() AND status = 'unsubmitted')
  WITH CHECK (account_id = app_actor() AND status IN ('unsubmitted', 'submitted'));

-- Ops reviews KYC and sets the tier that results.
GRANT SELECT ON account TO sidequest_ops;
GRANT UPDATE (verification_tier, suspended_at, updated_at) ON account TO sidequest_ops;
CREATE POLICY ops_read_account ON account FOR SELECT TO sidequest_ops USING (app_has_ent('ops.read'));
CREATE POLICY ops_tier_account ON account FOR UPDATE TO sidequest_ops
  USING (app_has_ent('kyc.review')) WITH CHECK (app_has_ent('kyc.review'));

-- ─────────────────────────────────────────────── 5. errands

-- The requester's ceiling on the runner fee. Funding covers it; 0003's nearby query already
-- referenced it and failed because it did not exist.
ALTER TABLE errand ADD COLUMN max_fee_cents bigint NOT NULL DEFAULT 0 CHECK (max_fee_cents >= 0);
ALTER TABLE errand ADD COLUMN pickup_label text;
ALTER TABLE errand ADD COLUMN handover_at timestamptz;

-- Tier-2 runners bid (entitlement bid.place) but the feed policy admitted only errand.accept
-- (tier 3), so a tier-2 runner could never see anything to bid on.
DROP POLICY errand_open_feed ON errand;
CREATE POLICY errand_open_feed ON errand FOR SELECT TO sidequest_app
  USING (status = 'open' AND (app_has_ent('bid.place') OR app_has_ent('errand.accept')));

-- Posting an errand creates its stalls and items. Only the runner could insert either.
CREATE POLICY stall_requester_insert ON stall FOR INSERT TO sidequest_app
  WITH CHECK (app_is_requester(errand_id));
CREATE POLICY item_requester_insert ON line_item FOR INSERT TO sidequest_app
  WITH CHECK (EXISTS (SELECT 1 FROM stall s WHERE s.id = line_item.stall_id AND app_is_requester(s.errand_id)));
-- Substitution: the requester marks the original item as not accepted.
CREATE POLICY item_requester_update ON line_item FOR UPDATE TO sidequest_app
  USING (EXISTS (SELECT 1 FROM stall s WHERE s.id = line_item.stall_id AND app_is_requester(s.errand_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM stall s WHERE s.id = line_item.stall_id AND app_is_requester(s.errand_id)));

-- Awarding a bid marks the bids won and lost, which is the requester writing rows the runner
-- owns. bid_own's WITH CHECK pinned every write to the runner.
CREATE POLICY bid_award ON bid FOR UPDATE TO sidequest_app
  USING (app_is_requester(errand_id)) WITH CHECK (app_is_requester(errand_id));

-- Escrow is created by the requester when they fund.
GRANT INSERT ON escrow TO sidequest_app;
CREATE POLICY escrow_create ON escrow FOR INSERT TO sidequest_app WITH CHECK (app_is_requester(errand_id));

-- A user reads their own wallet postings. Wallet groups carry no errand, so the party
-- policy could never admit them and GET /wallet would always show zero.
CREATE POLICY posting_owner ON posting FOR SELECT TO sidequest_app USING (owner_id = app_actor());
CREATE POLICY pgroup_owner ON posting_group FOR SELECT TO sidequest_app
  USING (EXISTS (SELECT 1 FROM posting p WHERE p.group_id = posting_group.id AND p.owner_id = app_actor()));

-- Ladder rung 3 needs the requester's answer stored somewhere the worker can read it.
ALTER TABLE tranche ADD COLUMN reimbursement_confirmed boolean;

-- The link handshake is two-sided: one party publishes a key before the other exists.
-- 0001 required both keys and the hash on insert, so the first party could never write.
-- destructive: acknowledged — NOT NULL relaxed on a table with no rows in any environment;
-- rollback is SET NOT NULL after deleting rows with a NULL key.
ALTER TABLE errand_link ALTER COLUMN requester_pub DROP NOT NULL;
ALTER TABLE errand_link ALTER COLUMN runner_pub    DROP NOT NULL;
ALTER TABLE errand_link ALTER COLUMN link_hash     DROP NOT NULL;

-- ─────────────────────────────────────────────── 6. new tables

-- Stored responses for Idempotency-Key replay (04-api.md: 24 hours).
CREATE TABLE idempotency_key (
  account_id   uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  key          text NOT NULL,
  route        text NOT NULL,
  request_hash text NOT NULL,
  status_code  smallint,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);
CREATE INDEX idempotency_key_age_idx ON idempotency_key (created_at);

-- Chat between the two parties. Closed 24h after settlement (enforced in the handler).
CREATE TABLE message (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  errand_id  uuid NOT NULL REFERENCES errand(id) ON DELETE CASCADE,
  sender_id  uuid NOT NULL REFERENCES account(id),
  body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_errand_idx ON message (errand_id, created_at DESC);

-- SOS: snapshot of location and both identities at the moment of the press.
CREATE TABLE sos_case (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  errand_id   uuid NOT NULL REFERENCES errand(id),
  raised_by   uuid NOT NULL REFERENCES account(id),
  lat         double precision,
  lng         double precision,
  snapshot    jsonb NOT NULL,
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sos_open_idx ON sos_case (created_at) WHERE resolved_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['idempotency_key', 'message', 'sos_case'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON idempotency_key TO sidequest_app;
CREATE POLICY idem_own ON idempotency_key FOR ALL TO sidequest_app
  USING (account_id = app_actor()) WITH CHECK (account_id = app_actor());
GRANT SELECT, DELETE ON idempotency_key TO sidequest_worker;
CREATE POLICY idem_retention ON idempotency_key FOR ALL TO sidequest_worker USING (true);

GRANT SELECT, INSERT ON message TO sidequest_app;
CREATE POLICY message_party ON message FOR SELECT TO sidequest_app USING (app_is_party(errand_id));
CREATE POLICY message_send  ON message FOR INSERT TO sidequest_app
  WITH CHECK (sender_id = app_actor() AND app_is_party(errand_id));
GRANT SELECT ON message TO sidequest_ops;
CREATE POLICY ops_read_message ON message FOR SELECT TO sidequest_ops USING (app_has_ent('evidence.view'));

GRANT SELECT, INSERT ON sos_case TO sidequest_app;
CREATE POLICY sos_raise ON sos_case FOR INSERT TO sidequest_app
  WITH CHECK (raised_by = app_actor() AND app_is_party(errand_id));
CREATE POLICY sos_own ON sos_case FOR SELECT TO sidequest_app USING (raised_by = app_actor());
GRANT SELECT, UPDATE ON sos_case TO sidequest_ops;
CREATE POLICY ops_sos ON sos_case FOR ALL TO sidequest_ops USING (app_has_ent('ops.read')) WITH CHECK (app_has_ent('ops.read'));

-- ─────────────────────────────────────────────── 7. worker reach
--
-- The worker drains the outbox and runs the ladder, settlement and notifications. 0003
-- granted it the money tables and nothing it needed to read them in context: no errand, no
-- stall, no account (so no msisdn to text), and no INSERT on outbox_event, so a job could
-- never chain a follow-up.

-- kyc_case is deliberately absent: identity documents stay out of the worker's reach.
GRANT SELECT, UPDATE ON errand, stall, errand_fee, errand_offer, errand_link, runner_location,
                        dispute TO sidequest_worker;
GRANT SELECT ON line_item, bid, account, errand_checkpoint, ruling, message TO sidequest_worker;
GRANT SELECT, INSERT, UPDATE ON relationship, errand_eta TO sidequest_worker;
GRANT INSERT ON outbox_event TO sidequest_worker;
GRANT UPDATE ON notification TO sidequest_worker;
GRANT SELECT ON notification TO sidequest_worker;

CREATE POLICY w_errand     ON errand            FOR ALL    TO sidequest_worker USING (true) WITH CHECK (true);
CREATE POLICY w_stall      ON stall             FOR ALL    TO sidequest_worker USING (true) WITH CHECK (true);
CREATE POLICY w_item       ON line_item         FOR SELECT TO sidequest_worker USING (true);
CREATE POLICY w_bid        ON bid               FOR SELECT TO sidequest_worker USING (true);
CREATE POLICY w_fee        ON errand_fee        FOR ALL    TO sidequest_worker USING (true) WITH CHECK (true);
CREATE POLICY w_offer      ON errand_offer      FOR ALL    TO sidequest_worker USING (true) WITH CHECK (true);
CREATE POLICY w_link       ON errand_link       FOR ALL    TO sidequest_worker USING (true) WITH CHECK (true);
CREATE POLICY w_loc        ON runner_location   FOR ALL    TO sidequest_worker USING (true) WITH CHECK (true);
CREATE POLICY w_dispute    ON dispute           FOR ALL    TO sidequest_worker USING (true) WITH CHECK (true);
CREATE POLICY w_account    ON account           FOR SELECT TO sidequest_worker USING (true);
CREATE POLICY w_checkpoint ON errand_checkpoint FOR SELECT TO sidequest_worker USING (true);
CREATE POLICY w_ruling     ON ruling            FOR SELECT TO sidequest_worker USING (true);
CREATE POLICY w_message    ON message           FOR SELECT TO sidequest_worker USING (true);
CREATE POLICY w_rel        ON relationship      FOR ALL    TO sidequest_worker USING (true) WITH CHECK (true);
CREATE POLICY w_eta        ON errand_eta        FOR ALL    TO sidequest_worker USING (true) WITH CHECK (true);
CREATE POLICY w_notif      ON notification      FOR ALL    TO sidequest_worker USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────── 8. ops reach

GRANT INSERT ON outbox_event TO sidequest_ops;
GRANT USAGE, SELECT ON SEQUENCE outbox_event_id_seq TO sidequest_ops;
CREATE POLICY outbox_ops ON outbox_event FOR INSERT TO sidequest_ops
  WITH CHECK (app_has_ent('legal_ops') OR app_has_ent('ops.read'));
GRANT UPDATE (status) ON dispute TO sidequest_ops;
CREATE POLICY ops_dispute_status ON dispute FOR UPDATE TO sidequest_ops
  USING (app_has_ent('legal_ops')) WITH CHECK (app_has_ent('legal_ops'));
GRANT SELECT ON ruling TO sidequest_ops;
CREATE POLICY ops_read_ruling ON ruling FOR SELECT TO sidequest_ops USING (app_has_ent('ops.read'));
GRANT SELECT ON kyc_case TO sidequest_ops;
GRANT SELECT ON errand_checkpoint, bid, relationship TO sidequest_ops;
CREATE POLICY ops_read_cp  ON errand_checkpoint FOR SELECT TO sidequest_ops USING (app_has_ent('ops.read'));
CREATE POLICY ops_read_bid ON bid               FOR SELECT TO sidequest_ops USING (app_has_ent('ops.read'));
CREATE POLICY ops_read_rel ON relationship      FOR SELECT TO sidequest_ops USING (app_has_ent('ops.read'));

-- ─────────────────────────────────────────────── 9. sequences
--
-- bigserial columns need USAGE on their sequence. Without these every INSERT into posting,
-- the location trail and the checkpoints failed with "permission denied for sequence".
GRANT USAGE, SELECT ON SEQUENCE posting_id_seq                 TO sidequest_app, sidequest_worker;
GRANT USAGE, SELECT ON SEQUENCE runner_location_history_id_seq TO sidequest_app, sidequest_worker;
GRANT USAGE, SELECT ON SEQUENCE errand_checkpoint_id_seq       TO sidequest_app;
GRANT USAGE, SELECT ON SEQUENCE outbox_event_id_seq            TO sidequest_worker;

COMMIT;
