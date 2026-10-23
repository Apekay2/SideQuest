-- 0012_hardening.sql
-- Production-readiness audit, 23 October 2026. Each section states the failure it prevents.
--
-- destructive: acknowledged — §2 drops NOT NULL on dispute.raised_by so the platform can open a
-- dispute itself (a stuck errand). Rollback: delete or reassign system disputes
-- (origin = 'system'), then ALTER TABLE dispute ALTER COLUMN raised_by SET NOT NULL.

-- ─────────────────────────────────────────────── 1. client money never goes negative
--
-- The ledger proved that every posting group balances, and nothing more. Whether a wallet,
-- an earnings balance or an errand's escrow could go below zero was left to the application
-- taking the right advisory lock at every call site — and the M-Pesa callback that funds an
-- errand from the wallet did not take it, so a withdrawal racing that callback could spend the
-- same shillings twice. Reconciliation would page the next morning; this refuses the commit.
--
-- Deferred like the balance trigger, so a group is judged as a whole at commit, and owned by
-- the definer role so it sums every posting, not the ones the caller's RLS lets it see.

CREATE INDEX IF NOT EXISTS posting_group_errand_idx ON posting_group (errand_id);

CREATE OR REPLACE FUNCTION assert_client_money_nonnegative() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$$
DECLARE
  bal bigint;
  errand uuid;
BEGIN
  IF NEW.account IN ('user_wallet', 'runner_earnings', 'reimbursement_due') THEN
    SELECT COALESCE(sum(amount_cents), 0) INTO bal FROM posting
     WHERE account = NEW.account AND owner_id IS NOT DISTINCT FROM NEW.owner_id AND currency = NEW.currency;
  ELSIF NEW.account IN ('escrow_hold', 'errand_card_float') THEN
    SELECT g.errand_id INTO errand FROM posting_group g WHERE g.id = NEW.group_id;
    SELECT COALESCE(sum(p.amount_cents), 0) INTO bal
      FROM posting p JOIN posting_group g ON g.id = p.group_id
     WHERE p.account = NEW.account AND p.currency = NEW.currency
       AND g.errand_id IS NOT DISTINCT FROM errand
       AND (NEW.account <> 'escrow_hold' OR p.owner_id IS NOT DISTINCT FROM NEW.owner_id);
  ELSE
    RETURN NULL;   -- platform revenue, vendor and rail boundary accounts are not client money
  END IF;
  IF bal < 0 THEN
    RAISE EXCEPTION 'client money would go negative: % for owner % is %', NEW.account, NEW.owner_id, bal
      USING ERRCODE = '23514', HINT = 'LEDGER_NEGATIVE_BALANCE';
  END IF;
  RETURN NULL;
END
$$;
ALTER FUNCTION assert_client_money_nonnegative() OWNER TO sidequest_definer;

CREATE CONSTRAINT TRIGGER posting_client_money_nonnegative
  AFTER INSERT ON posting DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_client_money_nonnegative();

-- ─────────────────────────────────────────────── 2. disputes the platform raises
--
-- An errand could sit in `handover` (the requester never showed the QR), `shopping` or
-- `awarded` (the runner went quiet) indefinitely, with the requester's money held in escrow
-- and no timer to release it. The worker's watchdog now opens a dispute on such an errand,
-- which freezes it and puts it in front of Legal Operations. Nobody raised it, so raised_by is
-- empty and `origin` says who did.

ALTER TABLE dispute ALTER COLUMN raised_by DROP NOT NULL;
ALTER TABLE dispute ADD COLUMN origin text NOT NULL DEFAULT 'party'
  CHECK (origin IN ('party', 'system'));
ALTER TABLE dispute ADD CONSTRAINT dispute_raiser_present
  CHECK (origin = 'system' OR raised_by IS NOT NULL);
GRANT INSERT ON dispute TO sidequest_worker;

-- ─────────────────────────────────────────────── 3. SOS escalation
--
-- An SOS wrote a log line and waited for someone to open the console. The worker now pages the
-- safety on-call and pages again until a person acknowledges; it reads the case to know when to
-- stop and records how many times it has paged.

ALTER TABLE sos_case ADD COLUMN escalations integer NOT NULL DEFAULT 0;
ALTER TABLE sos_case ADD COLUMN last_escalated_at timestamptz;
GRANT SELECT ON sos_case TO sidequest_worker;
GRANT UPDATE (escalations, last_escalated_at) ON sos_case TO sidequest_worker;
CREATE POLICY w_sos ON sos_case FOR ALL TO sidequest_worker USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────── 4. four-eyes on tier-3 verification
--
-- Tier 3 is the tier that carries a spending card and streams live location to strangers'
-- phones. One reviewer could grant it alone. A tier-3 approval now needs two different
-- officers; the first approval is recorded here and the case stays `in_review`.

ALTER TABLE kyc_case ADD COLUMN first_reviewed_by uuid REFERENCES account(id);
ALTER TABLE kyc_case ADD COLUMN first_reviewed_at timestamptz;
