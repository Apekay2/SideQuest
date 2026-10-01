-- 0009_push.sql
-- Device push tokens. The notify worker already wrote "push" notifications but nothing
-- delivered them: a notification reached an app only while it was open (socket or poll).

CREATE TABLE push_token (
  -- Expo push tokens: ExponentPushToken[…] (or ExpoPushToken[…]).
  token        text PRIMARY KEY CHECK (token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,64}\]$'),
  account_id   uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  platform     text NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Set when the push service reports the device gone (uninstalled, token rotated).
  revoked_at   timestamptz
);
CREATE INDEX push_token_account_idx ON push_token (account_id) WHERE revoked_at IS NULL;

ALTER TABLE push_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_token FORCE ROW LEVEL SECURITY;

-- The app sees and removes only its own tokens.
GRANT SELECT, DELETE ON push_token TO sidequest_app;
CREATE POLICY push_own ON push_token FOR ALL TO sidequest_app
  USING (account_id = app_actor()) WITH CHECK (account_id = app_actor());

-- Registering goes through a definer function: one phone shared by two people (sign out, sign
-- in) presents a token that already belongs to the other account, a row the app cannot see.
-- The token moves to whoever registered it last; the previous account stops receiving.
GRANT SELECT, INSERT, UPDATE ON push_token TO sidequest_definer;
CREATE POLICY push_definer ON push_token FOR ALL TO sidequest_definer USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION app_claim_push_token(t text, p text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$$
BEGIN
  IF app_actor() IS NULL THEN
    RAISE EXCEPTION 'no actor' USING ERRCODE = '42501';
  END IF;
  INSERT INTO push_token (token, account_id, platform)
  VALUES (t, app_actor(), p)
  ON CONFLICT (token) DO UPDATE
    SET account_id = app_actor(), platform = EXCLUDED.platform, last_seen_at = now(), revoked_at = NULL;
END
$$;
ALTER FUNCTION app_claim_push_token(text, text) OWNER TO sidequest_definer;
REVOKE EXECUTE ON FUNCTION app_claim_push_token(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_claim_push_token(text, text) TO sidequest_app;

-- The worker reads tokens to deliver and revokes the ones the push service rejects.
GRANT SELECT, UPDATE (revoked_at) ON push_token TO sidequest_worker;
CREATE POLICY push_worker_read   ON push_token FOR SELECT TO sidequest_worker USING (true);
CREATE POLICY push_worker_revoke ON push_token FOR UPDATE TO sidequest_worker USING (true) WITH CHECK (true);
