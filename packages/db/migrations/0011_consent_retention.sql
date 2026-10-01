-- 0011_consent_retention.sql
-- Location consent a runner can withdraw and give again after approval, and the retention
-- schedule for personal data the worker cannot reach on its own (07-security §7.6).

-- ─────────────────────────────────────────────── location consent

-- The subject may only edit an unsubmitted case (kyc_self_update), so changing consent on an
-- approved case goes through here. It touches nothing but the two consent columns.
GRANT UPDATE (movement_consent, movement_consent_at) ON kyc_case TO sidequest_definer;

/** Give or withdraw consent to live location sharing. False when there is no approved tier-3 case. */
CREATE OR REPLACE FUNCTION app_set_movement_consent(consent boolean) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$$
DECLARE
  me uuid := app_actor();
  n integer;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'no actor' USING ERRCODE = '42501'; END IF;
  UPDATE kyc_case SET movement_consent = consent, movement_consent_at = now()
   WHERE account_id = me AND target_tier = 3 AND status = 'approved'
     AND movement_consent IS DISTINCT FROM consent;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0 OR EXISTS (SELECT 1 FROM kyc_case WHERE account_id = me AND target_tier = 3 AND status = 'approved');
END
$$;
ALTER FUNCTION app_set_movement_consent(boolean) OWNER TO sidequest_definer;
REVOKE EXECUTE ON FUNCTION app_set_movement_consent(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_set_movement_consent(boolean) TO sidequest_app;

-- ─────────────────────────────────────────────── retention

-- Errands whose records are still needed: a dispute not yet ruled, or not finished at all.
GRANT SELECT ON evidence, message TO sidequest_definer;
GRANT DELETE ON evidence, message TO sidequest_definer;
CREATE POLICY evidence_definer ON evidence FOR ALL TO sidequest_definer USING (true);
CREATE POLICY message_definer  ON message  FOR ALL TO sidequest_definer USING (true);

/**
 * One retention pass. Deletes the rows and returns the stored object keys for the worker to
 * delete from the bucket (the database cannot reach it):
 *   - rejected or expired KYC cases, 90 days after review: documents and encrypted fields
 *   - errand photos, 2 years after the errand was created
 *   - chat messages, 1 year after they were sent
 * Nothing attached to an errand that is still live or has a dispute open is touched.
 */
CREATE OR REPLACE FUNCTION app_retention_purge() RETURNS text[]
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$$
DECLARE
  keys text[] := '{}';
  more text[];
BEGIN
  WITH gone AS (
    DELETE FROM kyc_case
     WHERE status IN ('rejected', 'expired') AND COALESCE(reviewed_at, created_at) < now() - interval '90 days'
     RETURNING id_front_key, id_back_key, selfie_key, conduct_cert_key)
  SELECT COALESCE(array_agg(k) FILTER (WHERE k IS NOT NULL), '{}') INTO more
    FROM gone, LATERAL unnest(ARRAY[id_front_key, id_back_key, selfie_key, conduct_cert_key]) AS k;
  keys := keys || more;

  WITH gone AS (
    DELETE FROM evidence v USING errand e
     WHERE e.id = v.errand_id AND e.created_at < now() - interval '2 years'
       AND e.status IN ('settled', 'cancelled', 'expired')
       AND NOT EXISTS (SELECT 1 FROM dispute d WHERE d.errand_id = e.id AND d.status IN ('open', 'evidence'))
     RETURNING v.object_key)
  SELECT COALESCE(array_agg(object_key), '{}') INTO more FROM gone;
  keys := keys || more;

  DELETE FROM message m USING errand e
   WHERE e.id = m.errand_id AND m.created_at < now() - interval '1 year'
     AND e.status IN ('settled', 'cancelled', 'expired')
     AND NOT EXISTS (SELECT 1 FROM dispute d WHERE d.errand_id = e.id AND d.status IN ('open', 'evidence'));

  RETURN keys;
END
$$;
ALTER FUNCTION app_retention_purge() OWNER TO sidequest_definer;
REVOKE EXECUTE ON FUNCTION app_retention_purge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_retention_purge() TO sidequest_worker;

-- ─────────────────────────────────────────────── access

-- The app role never reads msisdn (0006). The subject's own number belongs in their export.
CREATE OR REPLACE FUNCTION app_my_msisdn() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT msisdn FROM account WHERE id = app_actor() $$;
ALTER FUNCTION app_my_msisdn() OWNER TO sidequest_definer;
REVOKE EXECUTE ON FUNCTION app_my_msisdn() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_my_msisdn() TO sidequest_app;
