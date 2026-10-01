-- 0010_legal.sql
-- Legal obligations the schema has to carry (Kenya DPA 2019; App Store and Google Play rules):
--   * proof of what each person agreed to, and when (terms, privacy notice, 18+)
--   * location consent that is explicit, timestamped and revocable (07-security §7.6)
--   * an erasure log, so a deletion can be evidenced without keeping what was deleted

-- ─────────────────────────────────────────────── acceptance of terms and privacy notice

CREATE TABLE legal_acceptance (
  account_id  uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  document    text NOT NULL CHECK (document IN ('terms', 'privacy')),
  version     text NOT NULL CHECK (version ~ '^\d{4}-\d{2}-\d{2}$'),
  -- The person confirmed they are 18 or older when accepting (contracts and payments).
  adult       boolean NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, document, version)
);
ALTER TABLE legal_acceptance ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_acceptance FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON legal_acceptance TO sidequest_app;
CREATE POLICY legal_own ON legal_acceptance FOR ALL TO sidequest_app
  USING (account_id = app_actor()) WITH CHECK (account_id = app_actor() AND adult);
GRANT SELECT ON legal_acceptance TO sidequest_ops;
CREATE POLICY legal_ops ON legal_acceptance FOR SELECT TO sidequest_ops USING (app_has_ent('ops.read'));

-- ─────────────────────────────────────────────── location consent

-- When consent was given or withdrawn. Withdrawing sets movement_consent false; the runner can
-- no longer stream location (location.routes checks it) until they consent again.
ALTER TABLE kyc_case ADD COLUMN movement_consent_at timestamptz;
UPDATE kyc_case SET movement_consent_at = COALESCE(reviewed_at, created_at) WHERE movement_consent;
GRANT UPDATE (movement_consent, movement_consent_at) ON kyc_case TO sidequest_app;

-- ─────────────────────────────────────────────── erasure

-- Evidence that an erasure happened and when, holding nothing that was erased.
CREATE TABLE erasure_log (
  account_id   uuid PRIMARY KEY,             -- the pseudonymised account row keeps this id
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  kyc_objects  integer NOT NULL DEFAULT 0     -- stored documents deleted
);
ALTER TABLE erasure_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE erasure_log FORCE ROW LEVEL SECURITY;
GRANT SELECT ON erasure_log TO sidequest_ops;
CREATE POLICY erasure_ops ON erasure_log FOR SELECT TO sidequest_ops USING (app_has_ent('ops.read'));

-- Erasure runs as the definer: it touches rows the app role must never write (msisdn, other
-- people's views of the account) and it must be all-or-nothing. It erases only the caller.
GRANT SELECT, UPDATE (display_name, msisdn, suspended_at, updated_at, staff_grants) ON account TO sidequest_definer;
CREATE POLICY account_definer ON account FOR ALL TO sidequest_definer USING (true) WITH CHECK (true);
GRANT SELECT, DELETE ON kyc_case, push_token TO sidequest_definer;
CREATE POLICY kyc_definer ON kyc_case FOR ALL TO sidequest_definer USING (true);
GRANT UPDATE (point) ON runner_location_history TO sidequest_definer;
GRANT SELECT ON runner_location_history TO sidequest_definer;
CREATE POLICY loch_definer ON runner_location_history FOR ALL TO sidequest_definer USING (true) WITH CHECK (true);
GRANT SELECT, DELETE ON runner_location TO sidequest_definer;
CREATE POLICY loc_definer ON runner_location FOR ALL TO sidequest_definer USING (true);
GRANT SELECT, INSERT, UPDATE ON erasure_log TO sidequest_definer;
CREATE POLICY erasure_definer ON erasure_log FOR ALL TO sidequest_definer USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE (revoked_at) ON session TO sidequest_definer;   -- policies exist (0008)
GRANT SELECT ON errand, dispute TO sidequest_definer;
CREATE POLICY errand_definer_read ON errand FOR SELECT TO sidequest_definer USING (true);
CREATE POLICY dispute_definer_read ON dispute FOR SELECT TO sidequest_definer USING (true);

/**
 * Erase the calling account. Returns the KYC object keys for the API to delete from storage
 * (the database cannot reach the bucket). Refuses while anything is still owed or open; the
 * API checks money balances before calling (ledger reads are its job).
 */
CREATE OR REPLACE FUNCTION app_erase_self() RETURNS text[]
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$$
DECLARE
  me uuid := app_actor();
  keys text[];
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'no actor' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM account WHERE id = me AND role = 'staff') THEN
    RAISE EXCEPTION 'staff accounts are closed by a staff admin' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM errand WHERE (requester_id = me OR runner_id = me)
               AND status NOT IN ('draft', 'settled', 'cancelled', 'expired')) THEN
    RAISE EXCEPTION 'errands in progress' USING ERRCODE = 'P0001', HINT = 'LIVE_ERRANDS';
  END IF;
  IF EXISTS (SELECT 1 FROM dispute d JOIN errand e ON e.id = d.errand_id
              WHERE (e.requester_id = me OR e.runner_id = me) AND d.status IN ('open', 'evidence')) THEN
    RAISE EXCEPTION 'open dispute' USING ERRCODE = 'P0001', HINT = 'OPEN_DISPUTE';
  END IF;

  SELECT COALESCE(array_agg(k) FILTER (WHERE k IS NOT NULL), '{}') INTO keys
    FROM kyc_case, LATERAL unnest(ARRAY[id_front_key, id_back_key, selfie_key, conduct_cert_key]) AS k
   WHERE account_id = me;

  DELETE FROM kyc_case WHERE account_id = me;
  DELETE FROM push_token WHERE account_id = me;
  DELETE FROM runner_location WHERE runner_id = me;
  UPDATE runner_location_history SET point = NULL WHERE runner_id = me AND point IS NOT NULL;
  UPDATE session SET revoked_at = now() WHERE account_id = me AND revoked_at IS NULL;
  -- Pseudonymise. The id stays so the ledger, rulings and the other party's history keep
  -- their references; the number is freed so it can sign up afresh.
  UPDATE account SET display_name = 'Deleted user', msisdn = 'erased:' || me::text,
         suspended_at = now(), staff_grants = '{}', updated_at = now()
   WHERE id = me;
  INSERT INTO erasure_log (account_id, completed_at, kyc_objects) VALUES (me, now(), cardinality(keys))
    ON CONFLICT (account_id) DO UPDATE SET completed_at = now();
  RETURN keys;
END
$$;
ALTER FUNCTION app_erase_self() OWNER TO sidequest_definer;
REVOKE EXECUTE ON FUNCTION app_erase_self() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_erase_self() TO sidequest_app;
