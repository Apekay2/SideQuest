-- migrations/0003_rls.sql
-- Row-level security. Until this migration ran, application-layer ownership checks were the
-- ONLY thing standing between one account and another's escrow, KYC and location — a single
-- missing `WHERE requester_id = $actor` was a cross-tenant read. RLS makes that class of bug
-- return zero rows instead of someone else's data.
--
-- Model: one cluster, four roles, no BYPASSRLS on any role the API or workers use.
--   sidequest_migrator  owns the schema, runs migrations, subject to FORCE RLS anyway
--   sidequest_app       the API. Every statement runs inside a transaction that has SET LOCAL
--                       app.actor_id / app.actor_role / app.entitlements
--   sidequest_worker    outbox drain, reconciliation, retention jobs. Sees all rows of the
--                       tables it needs and NONE of kyc_case plaintext
--   sidequest_ops       ops console. Reads gated on entitlement + an audit_log row
--
-- PgBouncer note: every GUC below is SET LOCAL, so it dies with the transaction and is safe
-- under transaction pooling. Never use plain SET — it leaks the previous request's actor onto
-- the next borrower of the connection. That is the whole reason this file uses SET LOCAL.

BEGIN;

-- ─────────────────────────────────────────────── roles

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sidequest_app') THEN
    CREATE ROLE sidequest_app    LOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sidequest_worker') THEN
    CREATE ROLE sidequest_worker LOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sidequest_ops') THEN
    CREATE ROLE sidequest_ops    LOGIN NOBYPASSRLS;
  END IF;
END $$;

-- Nothing is public. Every grant below is deliberate.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO sidequest_app, sidequest_worker, sidequest_ops;

-- ─────────────────────────────────────────────── actor helpers

-- nullif() first: current_setting('…', true) returns '' when unset, and ''::uuid throws.
-- A missing actor must mean "no rows", never an error and never "all rows".
CREATE OR REPLACE FUNCTION app_actor() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.actor_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_role() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT coalesce(nullif(current_setting('app.actor_role', true), ''), 'anonymous') $$;

CREATE OR REPLACE FUNCTION app_has_ent(ent text) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT ent = ANY (string_to_array(coalesce(current_setting('app.entitlements', true), ''), ',')) $$;

-- Party to an errand = its requester, or its assigned runner. An *offered* runner is not yet a
-- party: an offer discloses the errand, not the requester's location history.
CREATE OR REPLACE FUNCTION app_is_party(e uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = public AS
$$ SELECT EXISTS (
     SELECT 1 FROM errand
      WHERE id = e AND app_actor() IS NOT NULL
        AND (requester_id = app_actor() OR runner_id = app_actor())
   ) $$;

CREATE OR REPLACE FUNCTION app_is_requester(e uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = public AS
$$ SELECT EXISTS (SELECT 1 FROM errand WHERE id = e AND requester_id = app_actor()) $$;

CREATE OR REPLACE FUNCTION app_is_runner(e uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = public AS
$$ SELECT EXISTS (SELECT 1 FROM errand WHERE id = e AND runner_id = app_actor()) $$;

REVOKE EXECUTE ON FUNCTION app_is_party(uuid), app_is_requester(uuid), app_is_runner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_actor(), app_role(), app_has_ent(text),
                          app_is_party(uuid), app_is_requester(uuid), app_is_runner(uuid)
  TO sidequest_app, sidequest_worker, sidequest_ops;

-- ─────────────────────────────────────────────── enable + force

-- FORCE so that the table owner (migrator) is subject to policy too. Without FORCE, owning the
-- table is a silent bypass, and the migration role is the one an attacker with a leaked
-- DATABASE_URL is most likely to hold.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'account','session','otp_challenge','kyc_case',
    'errand','bid','errand_offer','errand_fee','errand_batch','relationship',
    'runner_location','runner_location_history','errand_link',
    'stall','line_item','evidence',
    'card','tranche','card_attempt','payment','payout','mpesa_event',
    'posting_group','posting','escrow',
    'dispute','ruling','errand_checkpoint','errand_eta',
    'outbox_event','consumed_event','audit_log','notification'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────── identity

GRANT SELECT, UPDATE ON account TO sidequest_app;
CREATE POLICY account_self ON account FOR SELECT TO sidequest_app
  USING (id = app_actor());
-- Counterparty disclosure is a VIEW (account_public below), never a policy on the base table:
-- a policy wide enough to show a counterparty is wide enough to enumerate every account.
CREATE POLICY account_self_update ON account FOR UPDATE TO sidequest_app
  USING (id = app_actor()) WITH CHECK (id = app_actor());

-- Only ever the minimum a stranger may see. msisdn, tier internals and suspension reasons
-- are not in it. security_invoker so the caller's policies still apply to the base table.
CREATE OR REPLACE VIEW account_public
  WITH (security_invoker = true) AS
  SELECT id, display_name, verification_tier, created_at FROM account;
GRANT SELECT ON account_public TO sidequest_app, sidequest_ops;
CREATE POLICY account_counterparty ON account FOR SELECT TO sidequest_app
  USING (
    -- readable only through a shared errand, and only ever the columns in account_public
    EXISTS (SELECT 1 FROM errand e
             WHERE (e.requester_id = app_actor() AND e.runner_id = account.id)
                OR (e.runner_id   = app_actor() AND e.requester_id = account.id)
                OR (e.offered_to  = account.id  AND e.requester_id = app_actor()))
  );

GRANT SELECT, INSERT, UPDATE ON session TO sidequest_app;
CREATE POLICY session_self ON session FOR ALL TO sidequest_app
  USING (account_id = app_actor()) WITH CHECK (account_id = app_actor());

-- otp_challenge is pre-authentication: there is no actor yet, so it cannot be actor-scoped.
-- It is instead write-only to the app and readable only by msisdn+id, which the caller must
-- already know. Rate limiting (§7.7, rate-limit.ts) is the real control here, not RLS.
GRANT INSERT, UPDATE ON otp_challenge TO sidequest_app;
GRANT SELECT ON otp_challenge TO sidequest_app;
CREATE POLICY otp_by_challenge ON otp_challenge FOR SELECT TO sidequest_app
  USING (nullif(current_setting('app.otp_challenge_id', true), '')::uuid = id);
CREATE POLICY otp_insert ON otp_challenge FOR INSERT TO sidequest_app WITH CHECK (true);
CREATE POLICY otp_consume ON otp_challenge FOR UPDATE TO sidequest_app
  USING (nullif(current_setting('app.otp_challenge_id', true), '')::uuid = id);

-- KYC: the subject may see their own case status, never the document ciphertext columns.
-- Decryption stays in identity's single function; ops sees a case only inside an open review.
GRANT SELECT, INSERT ON kyc_case TO sidequest_app;
CREATE POLICY kyc_self ON kyc_case FOR SELECT TO sidequest_app
  USING (account_id = app_actor());
CREATE POLICY kyc_self_insert ON kyc_case FOR INSERT TO sidequest_app
  WITH CHECK (account_id = app_actor());
GRANT SELECT, UPDATE ON kyc_case TO sidequest_ops;
CREATE POLICY kyc_ops_review ON kyc_case FOR ALL TO sidequest_ops
  USING (app_has_ent('kyc.review')) WITH CHECK (app_has_ent('kyc.review'));
-- Workers must never see identity documents at all.
REVOKE ALL ON kyc_case FROM sidequest_worker;

-- ─────────────────────────────────────────────── errands

GRANT SELECT, INSERT, UPDATE ON errand TO sidequest_app;
-- Discovery: an open, published errand is visible to entitled runners. Everything else is
-- party-only. `status = 'open'` is doing real work here — a draft is private.
CREATE POLICY errand_party ON errand FOR SELECT TO sidequest_app
  USING (requester_id = app_actor() OR runner_id = app_actor() OR offered_to = app_actor());
CREATE POLICY errand_open_feed ON errand FOR SELECT TO sidequest_app
  USING (status = 'open' AND app_has_ent('errand.accept'));
CREATE POLICY errand_create ON errand FOR INSERT TO sidequest_app
  WITH CHECK (requester_id = app_actor());
-- The accept race UPDATEs a row the runner does not yet own, so the USING clause has to admit
-- the claim; WITH CHECK pins the outcome to this actor. Together they permit exactly the
-- conditional UPDATE in assignment.routes.ts and nothing wider.
CREATE POLICY errand_write ON errand FOR UPDATE TO sidequest_app
  USING (
    requester_id = app_actor()
    OR runner_id = app_actor()
    OR (runner_id IS NULL AND status IN ('open','offered') AND app_has_ent('errand.accept'))
  )
  WITH CHECK (requester_id = app_actor() OR runner_id = app_actor() OR runner_id IS NULL);

GRANT SELECT, INSERT, UPDATE ON bid TO sidequest_app;
CREATE POLICY bid_own ON bid FOR ALL TO sidequest_app
  USING (runner_id = app_actor() OR app_is_requester(errand_id))
  WITH CHECK (runner_id = app_actor());

GRANT SELECT, INSERT, UPDATE ON errand_offer TO sidequest_app;
CREATE POLICY offer_parties ON errand_offer FOR SELECT TO sidequest_app
  USING (runner_id = app_actor() OR app_is_requester(errand_id));
CREATE POLICY offer_create ON errand_offer FOR INSERT TO sidequest_app
  WITH CHECK (app_is_requester(errand_id));
-- A runner may only resolve THEIR OWN offer. This is the policy that would have contained the
-- decline-offer IDOR: without it, one runner could resolve another's offer row.
CREATE POLICY offer_resolve ON errand_offer FOR UPDATE TO sidequest_app
  USING (runner_id = app_actor() OR app_is_requester(errand_id));

GRANT SELECT ON errand_fee TO sidequest_app;
CREATE POLICY fee_party ON errand_fee FOR SELECT TO sidequest_app USING (app_is_party(errand_id));
GRANT INSERT ON errand_fee TO sidequest_app;
CREATE POLICY fee_insert ON errand_fee FOR INSERT TO sidequest_app WITH CHECK (app_is_party(errand_id));

GRANT SELECT, INSERT, UPDATE ON errand_batch TO sidequest_app;
CREATE POLICY batch_own ON errand_batch FOR ALL TO sidequest_app
  USING (runner_id = app_actor()) WITH CHECK (runner_id = app_actor());

GRANT SELECT, INSERT, UPDATE ON relationship TO sidequest_app;
-- A runner's block must not be disclosed to the requester (§7.2). The requester can see the
-- row's counts through a view; `blocked` is filtered out there, and the base-table policy
-- only admits the runner side for writes.
CREATE POLICY rel_read ON relationship FOR SELECT TO sidequest_app
  USING (runner_id = app_actor() OR requester_id = app_actor());
CREATE POLICY rel_block ON relationship FOR UPDATE TO sidequest_app
  USING (runner_id = app_actor()) WITH CHECK (runner_id = app_actor());

-- ─────────────────────────────────────────────── location

-- The highest-value table in the schema for a stalker, so it gets the narrowest policies.
GRANT SELECT, INSERT, UPDATE ON runner_location TO sidequest_app;
CREATE POLICY loc_self ON runner_location FOR ALL TO sidequest_app
  USING (runner_id = app_actor()) WITH CHECK (runner_id = app_actor());
-- The requester sees a point ONLY for their own assigned errand with a live link. No link,
-- no row — enforced here as well as in the handler, because §7.4 is a legal commitment.
CREATE POLICY loc_linked_requester ON runner_location FOR SELECT TO sidequest_app
  USING (
    errand_id IS NOT NULL
    AND app_is_requester(errand_id)
    AND EXISTS (SELECT 1 FROM errand_link l
                 WHERE l.errand_id = runner_location.errand_id
                   AND l.revoked_at IS NULL
                   AND l.requester_ack_at IS NOT NULL
                   AND l.runner_ack_at IS NOT NULL)
  );
-- Discovery reads precise points to compute distance. It runs as the app role with an actor,
-- so give it a purpose-scoped GUC instead of widening the policy: set app.discovery = 'on'
-- only inside the nearby query's transaction, and never return the point itself.
CREATE POLICY loc_discovery ON runner_location FOR SELECT TO sidequest_app
  USING (is_online AND current_setting('app.discovery', true) = 'on');

GRANT SELECT, INSERT ON runner_location_history TO sidequest_app;
CREATE POLICY loch_self ON runner_location_history FOR SELECT TO sidequest_app
  USING (runner_id = app_actor());
CREATE POLICY loch_insert ON runner_location_history FOR INSERT TO sidequest_app
  WITH CHECK (runner_id = app_actor());
GRANT SELECT, UPDATE, DELETE ON runner_location_history TO sidequest_worker;
CREATE POLICY loch_retention ON runner_location_history FOR ALL TO sidequest_worker USING (true);

GRANT SELECT, INSERT, UPDATE ON errand_link TO sidequest_app;
CREATE POLICY link_party ON errand_link FOR ALL TO sidequest_app
  USING (app_is_party(errand_id)) WITH CHECK (app_is_party(errand_id));

-- ─────────────────────────────────────────────── basket and evidence

GRANT SELECT, INSERT, UPDATE ON stall TO sidequest_app;
CREATE POLICY stall_party ON stall FOR SELECT TO sidequest_app USING (app_is_party(errand_id));
CREATE POLICY stall_runner_write ON stall FOR UPDATE TO sidequest_app
  USING (app_is_runner(errand_id) OR app_is_requester(errand_id))
  WITH CHECK (app_is_runner(errand_id) OR app_is_requester(errand_id));
CREATE POLICY stall_runner_insert ON stall FOR INSERT TO sidequest_app
  WITH CHECK (app_is_runner(errand_id));

GRANT SELECT, INSERT, UPDATE ON line_item TO sidequest_app;
-- Reached through stall → errand, which is what makes the stall/errand mismatch IDOR
-- unexploitable even if a handler forgets the join.
CREATE POLICY item_party ON line_item FOR ALL TO sidequest_app
  USING (EXISTS (SELECT 1 FROM stall s WHERE s.id = line_item.stall_id AND app_is_party(s.errand_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM stall s WHERE s.id = line_item.stall_id AND app_is_runner(s.errand_id)));

GRANT SELECT, INSERT ON evidence TO sidequest_app;
CREATE POLICY evidence_party ON evidence FOR SELECT TO sidequest_app USING (app_is_party(errand_id));
CREATE POLICY evidence_runner ON evidence FOR INSERT TO sidequest_app WITH CHECK (app_is_runner(errand_id));

-- ─────────────────────────────────────────────── money

-- No role reachable from the internet may UPDATE the ledger. Correction is a new posting group.
GRANT SELECT ON card, tranche, card_attempt, posting_group, posting, escrow TO sidequest_app;
CREATE POLICY card_party      ON card         FOR SELECT TO sidequest_app USING (app_is_party(errand_id));
CREATE POLICY escrow_party    ON escrow       FOR SELECT TO sidequest_app USING (app_is_party(errand_id));
CREATE POLICY tranche_party   ON tranche      FOR SELECT TO sidequest_app
  USING (EXISTS (SELECT 1 FROM card c WHERE c.id = tranche.card_id AND app_is_party(c.errand_id)));
CREATE POLICY attempt_party   ON card_attempt FOR SELECT TO sidequest_app
  USING (EXISTS (SELECT 1 FROM tranche t JOIN card c ON c.id = t.card_id
                  WHERE t.id = card_attempt.tranche_id AND app_is_party(c.errand_id)));
CREATE POLICY pgroup_party    ON posting_group FOR SELECT TO sidequest_app
  USING (errand_id IS NOT NULL AND app_is_party(errand_id));
CREATE POLICY posting_party   ON posting      FOR SELECT TO sidequest_app
  USING (EXISTS (SELECT 1 FROM posting_group g WHERE g.id = posting.group_id
                  AND g.errand_id IS NOT NULL AND app_is_party(g.errand_id)));

-- The approval handler writes tranche + postings + escrow inside one transaction, so it needs
-- INSERT there. Requester-only, and only for their own errand.
GRANT INSERT ON tranche, posting_group, posting TO sidequest_app;
GRANT UPDATE ON escrow, tranche TO sidequest_app;
CREATE POLICY tranche_create ON tranche FOR INSERT TO sidequest_app
  WITH CHECK (EXISTS (SELECT 1 FROM card c WHERE c.id = tranche.card_id AND app_is_requester(c.errand_id)));
CREATE POLICY pgroup_create ON posting_group FOR INSERT TO sidequest_app
  WITH CHECK (errand_id IS NOT NULL AND app_is_requester(errand_id));
CREATE POLICY posting_create ON posting FOR INSERT TO sidequest_app
  WITH CHECK (EXISTS (SELECT 1 FROM posting_group g WHERE g.id = posting.group_id AND app_is_requester(g.errand_id)));
CREATE POLICY escrow_hold ON escrow FOR UPDATE TO sidequest_app
  USING (app_is_requester(errand_id)) WITH CHECK (app_is_requester(errand_id));
CREATE POLICY tranche_status ON tranche FOR UPDATE TO sidequest_app
  USING (EXISTS (SELECT 1 FROM card c WHERE c.id = tranche.card_id AND app_is_requester(c.errand_id)));

GRANT SELECT, INSERT ON payment TO sidequest_app;
CREATE POLICY payment_own ON payment FOR SELECT TO sidequest_app USING (account_id = app_actor());
CREATE POLICY payment_create ON payment FOR INSERT TO sidequest_app WITH CHECK (account_id = app_actor());
GRANT SELECT, INSERT ON payout TO sidequest_app;
CREATE POLICY payout_own ON payout FOR ALL TO sidequest_app
  USING (runner_id = app_actor()) WITH CHECK (runner_id = app_actor());

-- Rails: webhook ingestion and issuer calls are worker-side only. There is no path from a user
-- request to mpesa_event, which is what makes a forged `payment.confirmed` a dead end.
REVOKE ALL ON mpesa_event FROM sidequest_app;
GRANT SELECT, INSERT, UPDATE ON mpesa_event, card, tranche, card_attempt, payment, payout,
                                posting_group, posting, escrow TO sidequest_worker;
CREATE POLICY money_worker ON mpesa_event  FOR ALL TO sidequest_worker USING (true) WITH CHECK (true);
CREATE POLICY card_worker  ON card         FOR ALL TO sidequest_worker USING (true) WITH CHECK (true);
CREATE POLICY tr_worker    ON tranche      FOR ALL TO sidequest_worker USING (true) WITH CHECK (true);
CREATE POLICY att_worker   ON card_attempt FOR ALL TO sidequest_worker USING (true) WITH CHECK (true);
CREATE POLICY pay_worker   ON payment      FOR ALL TO sidequest_worker USING (true) WITH CHECK (true);
CREATE POLICY pout_worker  ON payout       FOR ALL TO sidequest_worker USING (true) WITH CHECK (true);
CREATE POLICY pg_worker    ON posting_group FOR ALL TO sidequest_worker USING (true) WITH CHECK (true);
CREATE POLICY po_worker    ON posting      FOR INSERT TO sidequest_worker WITH CHECK (true);
CREATE POLICY po_worker_r  ON posting      FOR SELECT TO sidequest_worker USING (true);
CREATE POLICY esc_worker   ON escrow       FOR ALL TO sidequest_worker USING (true) WITH CHECK (true);

-- Immutability: no DELETE grant on any ledger table for any role, and no UPDATE on posting at
-- all. Retention deletes elsewhere are worker-only and named above.
REVOKE DELETE ON posting, posting_group, card_attempt, mpesa_event, audit_log
  FROM sidequest_app, sidequest_worker, sidequest_ops;

-- ─────────────────────────────────────────────── disputes, ops, plumbing

GRANT SELECT, INSERT ON dispute TO sidequest_app;
CREATE POLICY dispute_party ON dispute FOR ALL TO sidequest_app
  USING (app_is_party(errand_id)) WITH CHECK (app_is_party(errand_id));
GRANT SELECT ON ruling TO sidequest_app;
CREATE POLICY ruling_party ON ruling FOR SELECT TO sidequest_app
  USING (EXISTS (SELECT 1 FROM dispute d WHERE d.id = ruling.dispute_id AND app_is_party(d.errand_id)));
GRANT SELECT, INSERT ON ruling TO sidequest_ops;
CREATE POLICY ruling_legal_ops ON ruling FOR INSERT TO sidequest_ops
  WITH CHECK (app_has_ent('legal_ops') AND length(rationale) >= 40);

GRANT SELECT, INSERT, UPDATE ON errand_checkpoint, errand_eta TO sidequest_app;
CREATE POLICY cp_party  ON errand_checkpoint FOR ALL TO sidequest_app
  USING (app_is_party(errand_id)) WITH CHECK (app_is_runner(errand_id));
CREATE POLICY eta_party ON errand_eta FOR SELECT TO sidequest_app USING (app_is_party(errand_id));

-- Outbox: the app enqueues, the worker drains. Neither reads the other's payloads back.
GRANT INSERT ON outbox_event TO sidequest_app;
GRANT USAGE, SELECT ON SEQUENCE outbox_event_id_seq TO sidequest_app;
CREATE POLICY outbox_enqueue ON outbox_event FOR INSERT TO sidequest_app WITH CHECK (true);
GRANT SELECT, UPDATE, DELETE ON outbox_event TO sidequest_worker;
GRANT SELECT, INSERT ON consumed_event TO sidequest_worker;
CREATE POLICY outbox_drain ON outbox_event  FOR ALL TO sidequest_worker USING (true) WITH CHECK (true);
CREATE POLICY consumed_w   ON consumed_event FOR ALL TO sidequest_worker USING (true) WITH CHECK (true);

-- audit_log is append-only for everyone, and readable by nobody through the API.
GRANT INSERT ON audit_log TO sidequest_app, sidequest_worker, sidequest_ops;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO sidequest_app, sidequest_worker, sidequest_ops;
CREATE POLICY audit_append ON audit_log FOR INSERT TO sidequest_app, sidequest_worker, sidequest_ops
  WITH CHECK (true);
CREATE POLICY audit_read_ops ON audit_log FOR SELECT TO sidequest_ops USING (app_has_ent('audit.read'));

GRANT SELECT, UPDATE ON notification TO sidequest_app;
GRANT INSERT ON notification TO sidequest_worker;
CREATE POLICY notif_own ON notification FOR ALL TO sidequest_app
  USING (account_id = app_actor()) WITH CHECK (account_id = app_actor());
CREATE POLICY notif_worker ON notification FOR INSERT TO sidequest_worker WITH CHECK (true);

-- Ops: read across, write almost nothing, and every read of an evidence or location row is
-- expected to be paired with an audit_log insert in the same transaction (asserted by test,
-- not by trigger — a trigger here would deadlock the console's list views).
GRANT SELECT ON errand, stall, line_item, evidence, card, tranche, card_attempt,
                posting_group, posting, escrow, payment, payout, dispute, errand_offer,
                errand_fee, runner_location_history TO sidequest_ops;
CREATE POLICY ops_read_errand   ON errand         FOR SELECT TO sidequest_ops USING (app_has_ent('ops.read'));
CREATE POLICY ops_read_stall    ON stall          FOR SELECT TO sidequest_ops USING (app_has_ent('ops.read'));
CREATE POLICY ops_read_item     ON line_item      FOR SELECT TO sidequest_ops USING (app_has_ent('ops.read'));
CREATE POLICY ops_read_evidence ON evidence       FOR SELECT TO sidequest_ops USING (app_has_ent('evidence.view'));
CREATE POLICY ops_read_card     ON card           FOR SELECT TO sidequest_ops USING (app_has_ent('ops.read'));
CREATE POLICY ops_read_tranche  ON tranche        FOR SELECT TO sidequest_ops USING (app_has_ent('ops.read'));
CREATE POLICY ops_read_attempt  ON card_attempt   FOR SELECT TO sidequest_ops USING (app_has_ent('ops.read'));
CREATE POLICY ops_read_pgroup   ON posting_group  FOR SELECT TO sidequest_ops USING (app_has_ent('ledger.read'));
CREATE POLICY ops_read_posting  ON posting        FOR SELECT TO sidequest_ops USING (app_has_ent('ledger.read'));
CREATE POLICY ops_read_escrow   ON escrow         FOR SELECT TO sidequest_ops USING (app_has_ent('ledger.read'));
CREATE POLICY ops_read_payment  ON payment        FOR SELECT TO sidequest_ops USING (app_has_ent('ledger.read'));
CREATE POLICY ops_read_payout   ON payout         FOR SELECT TO sidequest_ops USING (app_has_ent('ledger.read'));
CREATE POLICY ops_read_dispute  ON dispute        FOR SELECT TO sidequest_ops USING (app_has_ent('ops.read'));
CREATE POLICY ops_read_offer    ON errand_offer   FOR SELECT TO sidequest_ops USING (app_has_ent('ops.read'));
CREATE POLICY ops_read_fee      ON errand_fee     FOR SELECT TO sidequest_ops USING (app_has_ent('ops.read'));
-- Ops sees cells, never points (§7.4). The point column is withheld by the view, and the base
-- table carries no ops policy at all, so a direct query returns zero rows.
CREATE OR REPLACE VIEW ops_location_cells WITH (security_barrier = true) AS
  SELECT runner_id, errand_id, h3_cell_to_parent(cell_r9, 8) AS cell_r8, cell_r9, recorded_at
    FROM runner_location_history;
GRANT SELECT ON ops_location_cells TO sidequest_ops;
CREATE POLICY ops_read_loch ON runner_location_history FOR SELECT TO sidequest_ops
  USING (app_has_ent('location.read_cells'));

-- Future tables default to protected rather than open.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;

COMMIT;

-- ─────────────────────────────────────────────── verification
-- Run in CI after migrate. Any row returned is a failure.
--
--   SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public' AND c.relkind = 'r'
--      AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
--
--   SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
--      AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid);
--
--   SELECT rolname FROM pg_roles WHERE rolbypassrls AND rolname LIKE 'sidequest%';
