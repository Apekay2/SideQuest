# System security audit checklist

_Started 2026-09-02 10:13 UTC_

---

## User

Continuing from "Coverage and gaps review".

## Assistant

We were designing Side Qwest for production launch — a gig-errand platform for Kenya with assignment (requester-pick or first-accept), dual-mode funding (upfront for fixed tasks, tranches for market runs), multi-rail payment (M-Pesa STK, paybill, wallet, card and bank deferred), and real-time location handshakes between runners and requesters.

Major decisions locked in: seven event-driven services (money, location, assignment, progress, auth, notifications, ops) over Redis Streams with per-service outbox; money module stays atomic because stall approval spans ledger, escrow, card, and tranche in one SERIALIZABLE transaction; fees at 12% split 50/50 between requester and runner at settlement; ETA checkpoint-based (stalls done vs remaining, no map routing); location via PostGIS + H3 res 8/9 for clustering and market-level matching; assignment through a conditional one-line UPDATE (WHERE runner_id IS NULL and optionally offered_to = $runner); link handshake uses X25519 + HMAC for location authenticity without the platform ever holding the shared secret.

Current state: Seven services documented with event flows, schemas v2 (runner_location with H3 cells, errand_link with handshake, revised ledger), pricing and ETA engines built, assignment routes complete. Security doc covers threat model by actor, money-path velocity limits, nightly reconciliation, GPS spoofing, DPA 2019 blockers, and risk acceptance. Scale doc shows location (266 fixes/s, 2.3 GB/day) dwarfs money (0.7 writes/s) — justifying the service split; flags issuer per-card fees at $30k/month, PgBouncer timing, and Legal Ops staffing as real blockers.

Three open actions before pilot: lock payment rail contracts (M-Pesa STK + wallet for pilot, paybill at launch, card/bank when PSP work lands), negotiate issuer card fees vs pooled-card fallback, and confirm load assumptions (50 / 500 / 10k runners).

Project files: `06-services.md`, `07-security.md`, `08-scale.md`, `03b-schema-v2.sql`, `pricing/fees.ts`, `progress/eta.ts`, `api/routes/assignment.routes.ts`, plus all prior domain and API code.

## User

Check, fix, and sanitize the whole system for RLS, rate limiting, API KEY hardcoding, XSS for session hijacking, and all cybersecurity vulnerabilities

## Assistant

_[tool: list_files]_

_[tool: list_files]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: grep]_

_[tool: grep]_

_[tool: grep]_

Found the real gaps. Writing the fixes.

_[tool: update_todos]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now the assignment routes — the decline-offer authorization hole and the ungated nearby endpoint.

_[tool: str_replace_edit]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: str_replace_edit]_

_[tool: update_todos]_

_[tool: show_to_user]_

Audit written to `09-appsec-audit.md` (12 findings, severity-ordered). Four were live vulnerabilities, not just missing hardening:

- **No RLS anywhere** — app-layer `WHERE` clauses were the only thing protecting escrow, KYC and location. Fixed in `03c-rls.sql`: four roles, none with `BYPASSRLS`, `FORCE RLS`, actor bound per transaction with `SET LOCAL` via `actor-context.ts` (plain `SET` leaks the actor across PgBouncer connections). `app.db.transaction` now throws — routes must use `app.tx(req, fn)`.
- **Stall IDOR** — `items`, `submit` and `decline` trusted `:sid` without binding it to `:id`, so a runner could reprice or decline any stall in the system.
- **`decline-offer` unauthorized** — any runner could knock a rival's offer back to `open`, free and repeatable.
- **`/runners/nearby` was a location scraper** — free-text lat/lng, metre-accurate distances, no gate and no limit, despite §7.2 claiming all three. Now errand-scoped origin, funded+published, distance bands instead of metres, rate limited, audited.

Rate limits existed only in prose; `rate-limit.ts` implements 17 buckets as an atomic Redis sliding window, failing closed on money and OTP. XSS→session-hijack chain broken at five points in `hardening.ts` plus boundary normalisation in `domain/text/sanitize.ts`. **No hardcoded keys found** — all provider credentials already resolved through `config()`; `env.ts` now rejects placeholder/low-entropy secrets and redacts itself when printed. Tests in `code/api/test/security/rls.test.ts`.

Two things need your decision: §9.5 lists six CI gates that none of this survives without, and §9.6 has five items I couldn't fix from this repo — Daraja source-IP verification, Play Integrity, break-glass DB access, the KYC encryption envelope, and a pen test of the assignment race. Want me to spec any of those next?

## User

As a panel of senior software engineers, DevSecOps engineers, and software audit and analysis experts, analyse, sanitise, correct, and report on the current state of the project and provide recommendations for when the project enters global markets.

## Assistant

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

Reading further turned up three defects worse than anything in the security pass. Correcting them first.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: show_to_user]_

Report is in `10-panel-review.md`. The panel read every file in `code/` and traced all four money paths posting by posting. Three of the six defects found are worse than anything in the security pass, and all six are corrected in place:

- **Settlement debited escrow twice** for every cash reimbursement. `settle()` released the reimbursement from escrow a second time and cancelled its own liability clearance with a duplicate posting. The group summed to zero, so the balance trigger *and* the nightly zero-sum reconciliation both passed — a balanced ledger that was economically wrong.
- **`&&` between two SQL predicates** in the ladder's reimbursement branch. JS returns the second operand, so the update ran as `WHERE rung = 'reimbursement'` across the whole table — one cash reimbursement marked every pending one in the system as paid.
- **The outbox was at-most-once.** It marked rows dispatched before enqueueing, so any crash in between permanently dropped `card.load` and `errand.settled` jobs. Rewritten as claim-lease-dispatch with parked poison rows (migration `03d`).

Plus a crash-recovery gap that stranded loaded cards (needed `IssuerPort.getLoad`), non-idempotent self-re-enqueues, and `split()` losing a cent on negatives.

Verdict: the design is materially better than the code implementing it, and the largest remaining gap isn't code — there's no CI, IaC, or migration gate in the package, so every control in `07` and `09` is currently unenforced. Pilot-ready at 50 runners once Phase 0 in §10.7 is done; not at 500 on the current pipeline.

On global markets, the one item that is cheap now and a painful migration later: `Cents` carries no currency tag and assumes two decimal places. That must change before the first non-KES row exists. Chargebacks are the other big one — M-Pesa has no consumer reversal, so entering any card-first market changes the escrow model, not just an adapter.

Want me to draft the Phase 0 pipeline (CI workflow, migration gate, reconciliation job), or the currency-tagged money type?

## User

Two things need your decision: §9.5 lists six CI gates that none of this survives without, and §9.6 has five items I couldn't fix from this repo — Daraja source-IP verification, Play Integrity, break-glass DB access, the KYC encryption envelope, and a pen test of the assignment race. Want me to spec any of those next? Yes, let's spec each one by one. Let's deal with "no CI, IaC, or migration gate in the package," so every control in 07 and 09 is currently unenforced. Also, check the currency tag; decimal places remain at 2, but for scaling, allow for multi-currency according to country. Draft the Phase 0 pipeline (CI workflow, migration gate, reconciliation job), or the currency-tagged money type and all these changes should be pushed on to documentation and code

## Assistant

Starting with the currency type since it's irreversible if skipped, then the pipeline, then the five specs.

_[tool: update_todos]_

## Assistant

_[tool: read_file]_

_[tool: read_file]_

Currency layer first — exponent stays 2 as you specified, but carried as data rather than assumed.

_[tool: write_file]_

_[tool: write_file]_

_[tool: str_replace_edit]_

_[tool: write_file]_

Currency layer done. Now the Phase 0 pipeline.

_[tool: write_file]_

_[tool: write_file]_

_[tool: str_replace_edit]_

_[tool: write_file]_

## User

Make our current design similar and user-friendly to both android and IOS users

## User

Make our current design similar and user-friendly to both android and IOS users

## Assistant

_[tool: list_files]_

_[tool: read_file]_

Design exists as React Native with the Organic tokens. Let me build the parity work against the real screens.

_[tool: copy_starter_component]_

_[tool: copy_starter_component]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: grep]_

_[tool: grep]_

Building the comparison against your real screens — Requester shell, the approval sheet, and the destructive confirm.

_[tool: dc_write]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: str_replace_edit]_

_[tool: ready_for_verification]_

The design is in `Cross-Platform Parity.dc.html` — your real screens on both platforms, side by side, with the reasoning against each difference.

The principle I applied: **brand is shared, chrome is native.** Same Organic palette, same Caprasimo/Figtree, same information in the same order, same words. What adapts is what each platform's users already have in their thumbs.

Three pairs, chosen where conventions actually collide:

- **Requester shell** — the biggest divergence. iOS keeps *Post* as a fifth tab; Android drops to four tabs and promotes Post to a FAB, because Material users look bottom-right for creation. Both keep it one thumb-reach away.
- **Stall approval** — held deliberately identical. Layout, order and copy are pixel-parity because an operator on a support call shouldn't need to ask which phone the user holds. Only feel adapts: grabber vs drag handle, dim vs ripple, 52pt vs 56dp.
- **Declining a stall** — iOS action sheet vs M3 dialog. Same three ways out, same two facts stated, completely different shape. Both use `accentDeep` rather than system red, which still passes 4.5:1 at 17px.

Accessibility takes the stricter of the two platforms on both: 48dp targets everywhere including iOS, 200% text scaling without clipping, and both languages checked at the widest button.

Written up in `11-cross-platform.md`, and `code/mobile/platform/adaptive.ts` is now the only file allowed to branch on `Platform.OS` — every difference is one entry in one table rather than scattered `Platform.select` calls.

Four things I couldn't decide for you, in §11.8: tablet/landscape support, minimum Android version, low-end device performance targets, and whether you want dark mode at all. The Organic palette is warm and light by intent, so a dark variant is a design exercise rather than a token flip.

## User

Found issues — fixing…

## Assistant

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: ready_for_verification]_

Fixed all three doc-integrity defects:

- `currency.ts` now points at `10-panel-review.md §10.6.1` rather than the non-existent `12-open-items.md`
- `11-cross-platform.md` §11.7 now names `code/ci/ci.yml` and `09-appsec-audit.md` §9.5 instead of referring to itself
- README index now lists `03e-currency.sql`, `code/ci/ci.yml`, `code/scripts/assert-rls-coverage.ts` and `code/worker/jobs/reconcile.job.ts`

The design itself is unchanged. The four linter warnings are false positives — `t.fontHeading` is the Caprasimo token from your own `theme/tokens.ts`, which the linter can't resolve through the variable.

