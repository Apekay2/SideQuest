-- 0007_ledger_append_only.sql
-- 0003 granted the worker UPDATE on posting_group in the same breath as the mutable money
-- tables (card, tranche, escrow). Nothing updates a posting group, and a posting group that can
-- be rewritten (its reason, its errand, its currency) undoes the ledger's audit story as surely
-- as an editable posting would. Found by scripts/assert-ledger-grants.ts, which now gates CI.

REVOKE UPDATE ON posting_group FROM sidequest_app, sidequest_worker, sidequest_ops;
REVOKE UPDATE ON posting, ruling, audit_log FROM sidequest_app, sidequest_worker, sidequest_ops;

-- The policy granted FOR ALL; narrow it to what the worker does: add groups and read them.
DROP POLICY pg_worker ON posting_group;
CREATE POLICY pg_worker_i ON posting_group FOR INSERT TO sidequest_worker WITH CHECK (true);
CREATE POLICY pg_worker_r ON posting_group FOR SELECT TO sidequest_worker USING (true);
