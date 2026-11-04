-- 0013_review_followups.sql
-- Follow-ups to the code review of the production-readiness audit (PR #5), 23 October 2026.

-- ─────────────────────────────────────────────── 1. the client-money check under concurrency
--
-- 0012 refused a commit that would take a wallet, earnings, escrow or float balance below
-- zero, by summing the ledger at commit. Two debits committing at the same moment would each
-- sum a ledger without the other, both pass, and together overdraw.
--
-- The check now takes a transaction lock on the balance before it sums. The second debit waits
-- for the first to commit, and its sum, read after the wait, includes the first: each statement
-- in this function takes a fresh snapshot under READ COMMITTED, which every posting path uses.
-- Wallet and earnings use the keys the application's own paths already hold ('wallet:<id>',
-- 'earnings:<id>'), so those paths re-enter their lock rather than queue on a second one. An
-- errand's escrow and float share one key, so a transaction that debits both takes one lock,
-- not two that another transaction could take in the other order.
--
-- Only debits are checked. A credit cannot take a balance below zero, and every debit in the
-- same transaction runs its own check, so credits no longer take locks they do not need.

CREATE OR REPLACE FUNCTION assert_client_money_nonnegative() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$$
DECLARE
  bal bigint;
  errand uuid;
BEGIN
  IF NEW.amount_cents >= 0 THEN
    RETURN NULL;
  END IF;
  IF NEW.account IN ('user_wallet', 'runner_earnings', 'reimbursement_due') THEN
    PERFORM pg_advisory_xact_lock(hashtext(
      CASE NEW.account WHEN 'user_wallet' THEN 'wallet:' WHEN 'runner_earnings' THEN 'earnings:' ELSE 'reimbursement:' END
      || COALESCE(NEW.owner_id::text, '')));
    SELECT COALESCE(sum(amount_cents), 0) INTO bal FROM posting
     WHERE account = NEW.account AND owner_id IS NOT DISTINCT FROM NEW.owner_id AND currency = NEW.currency;
  ELSIF NEW.account IN ('escrow_hold', 'errand_card_float') THEN
    SELECT g.errand_id INTO errand FROM posting_group g WHERE g.id = NEW.group_id;
    PERFORM pg_advisory_xact_lock(hashtext('errand-money:' || COALESCE(errand::text, '')));
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
