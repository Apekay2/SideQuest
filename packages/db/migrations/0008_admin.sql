-- 0008_admin.sql
-- What the ops console needs to run the business: account suspension, staff management and an
-- SOS queue. Also closes two gaps found while adding them:
--
--   * ops_tier_account let any kyc.review holder UPDATE any column ops may write on account —
--     so a KYC reviewer could also suspend people. RLS policies cannot see columns, so a
--     trigger now ties each column to its entitlement.
--   * The account read policy required ops.read, and RLS applies it to UPDATE as well, so a
--     reviewer holding kyc.review alone saw an empty KYC queue and approved cases whose tier
--     silently did not rise. Every entitlement that writes account can now read it.
--   * The audit_read_ops policy existed but ops had no SELECT grant on audit_log.
--   * ops could UPDATE every column of sos_case, including the reported location and snapshot,
--     with ops.read. Only the handling columns are writable now.

-- ─────────────────────────────────────────────── accounts

-- staff_grants and role become writable by ops; the trigger below decides by whom.
GRANT UPDATE (staff_grants, role) ON account TO sidequest_ops;

DROP POLICY ops_tier_account ON account;
CREATE POLICY ops_update_account ON account FOR UPDATE TO sidequest_ops
  USING (app_has_ent('kyc.review') OR app_has_ent('accounts.manage') OR app_has_ent('staff.admin'))
  WITH CHECK (app_has_ent('kyc.review') OR app_has_ent('accounts.manage') OR app_has_ent('staff.admin'));

CREATE POLICY ops_read_account_writers ON account FOR SELECT TO sidequest_ops
  USING (app_has_ent('kyc.review') OR app_has_ent('accounts.manage') OR app_has_ent('staff.admin'));

-- The staff entitlements a grant may contain. Kept here as well as in the domain package so a
-- console bug or a hand-written UPDATE cannot invent one.
CREATE OR REPLACE FUNCTION app_staff_entitlements() RETURNS text[]
  LANGUAGE sql IMMUTABLE AS
$$ SELECT ARRAY['ops.read','kyc.review','evidence.view','ledger.read','location.read_cells',
                'audit.read','legal_ops','accounts.manage','staff.admin'] $$;

CREATE OR REPLACE FUNCTION ops_account_guard() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF current_user <> 'sidequest_ops' THEN
    RETURN NEW;
  END IF;
  IF NEW.verification_tier IS DISTINCT FROM OLD.verification_tier AND NOT app_has_ent('kyc.review') THEN
    RAISE EXCEPTION 'verification tier needs kyc.review' USING ERRCODE = '42501';
  END IF;
  IF NEW.suspended_at IS DISTINCT FROM OLD.suspended_at THEN
    IF NOT app_has_ent('accounts.manage') THEN
      RAISE EXCEPTION 'suspension needs accounts.manage' USING ERRCODE = '42501';
    END IF;
    IF NEW.id = app_actor() THEN
      RAISE EXCEPTION 'staff cannot suspend or reinstate themselves' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.staff_grants IS DISTINCT FROM OLD.staff_grants OR NEW.role IS DISTINCT FROM OLD.role THEN
    IF NOT app_has_ent('staff.admin') THEN
      RAISE EXCEPTION 'staff changes need staff.admin' USING ERRCODE = '42501';
    END IF;
    IF NEW.id = app_actor() THEN
      RAISE EXCEPTION 'staff cannot change their own access' USING ERRCODE = '42501';
    END IF;
    -- Promotion only: a staff account is never turned back into a customer one (its history
    -- would then mix operator and customer actions). Removing access = empty grants.
    IF NEW.role IS DISTINCT FROM OLD.role AND NEW.role <> 'staff' THEN
      RAISE EXCEPTION 'a staff account cannot become a customer account' USING ERRCODE = '42501';
    END IF;
    IF NEW.role <> 'staff' AND cardinality(NEW.staff_grants) > 0 THEN
      RAISE EXCEPTION 'only staff accounts hold staff grants' USING ERRCODE = '42501';
    END IF;
    IF NOT NEW.staff_grants <@ app_staff_entitlements() THEN
      RAISE EXCEPTION 'unknown staff entitlement' USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER ops_account_guard BEFORE UPDATE ON account
  FOR EACH ROW EXECUTE FUNCTION ops_account_guard();

-- Suspending someone must stop them now, not when their access token runs out: revoke every
-- live session in the same transaction. Definer-owned so ops needs no general session access;
-- it re-checks the entitlement itself.
GRANT SELECT, UPDATE (revoked_at) ON session TO sidequest_definer;
CREATE POLICY session_definer_read   ON session FOR SELECT TO sidequest_definer USING (true);
CREATE POLICY session_definer_revoke ON session FOR UPDATE TO sidequest_definer USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION app_revoke_account_sessions(target uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$$
DECLARE n integer;
BEGIN
  IF NOT app_has_ent('accounts.manage') THEN
    RAISE EXCEPTION 'needs accounts.manage' USING ERRCODE = '42501';
  END IF;
  UPDATE session SET revoked_at = now() WHERE account_id = target AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
ALTER FUNCTION app_revoke_account_sessions(uuid) OWNER TO sidequest_definer;
REVOKE EXECUTE ON FUNCTION app_revoke_account_sessions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_revoke_account_sessions(uuid) TO sidequest_ops;

-- ─────────────────────────────────────────────── SOS handling

ALTER TABLE sos_case
  ADD COLUMN acknowledged_at timestamptz,
  ADD COLUMN acknowledged_by uuid REFERENCES account(id),
  ADD COLUMN resolved_by uuid REFERENCES account(id),
  ADD COLUMN resolution_note text CHECK (char_length(resolution_note) <= 1000);

REVOKE UPDATE ON sos_case FROM sidequest_ops;
GRANT UPDATE (acknowledged_at, acknowledged_by, resolved_at, resolved_by, resolution_note) ON sos_case TO sidequest_ops;

-- ─────────────────────────────────────────────── audit

-- The console's user page shows an account's recent audit trail to audit.read holders; the
-- policy (audit_read_ops) was there, the table grant was not.
GRANT SELECT ON audit_log TO sidequest_ops;
CREATE INDEX IF NOT EXISTS audit_log_subject_idx ON audit_log (subject, created_at DESC);
