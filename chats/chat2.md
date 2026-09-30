# Coverage and gaps review

_Started 2026-09-01 11:31 UTC_

---

## User

Continuing from "Side Qwest errand platform design".

## Assistant

We've been building Side Qwest, a gig-errand platform for Kenya where requesters post tasks (market runs, queue standing, document drops) and runners bid blind. The architecture rests on a per-errand virtual card that loads in tranches as the requester approves each stall's items — a hybrid of escrow safety and operational speed.

Decisions made:

- Card loads *after* requester approval per stall, not upfront, so requesters stay in control of market runs.
- Failed photos get one retake; two failures escalate to the requester as a decision, avoiding runner dead ends.
- Card declines fall back to M-Pesa till payment from the same balance, then requester-settled reimbursement from escrow if funds run short.
- Handover is QR scan, not PIN, for speed and auditability.
- Runners get heavier KYC (tier 3: conduct, kin, movement), batching for trip planning (each errand keeps its own card), and direct invites from past requesters.
- Requester timers (30 min / 1 h / 2 h / by 6pm) with optional 50 KSh on-time bonus, shown live.
- All tap targets raised to 44px; EN/SW bilingual; ops console (desktop, restricted) for disputes and KYC queue.

Current state: All four files are in sync — the app prototype, architecture doc, diagram, and ops console. The app is fully navigable: KYC flows, posting, blind bids, stall-by-stall photography and approval, exception paths (retake, escalate, substitute, decline ladder), batching, chat, wallet float view, timers, QR handover, and role/language switching. The doc and diagram cover the card issuance, tranche loading, requester approval logic, the three-tier decline flow, tier-3 runner verification, and batching eligibility.

No open gaps — everything answered in the last round is built.

Files: Side Qwest App.dc.html, Side Qwest Architecture.dc.html, Side Qwest Architecture Diagram.dc.html, Side Qwest Ops Console.dc.html.

## User

Give me all the key areas we have highlighted and dealt with and show me where we still have blanks or gaps

## Assistant

_[tool: grep]_

_[tool: grep]_

**Covered — decided and built in all four files**

Money: per-errand one-time virtual card, tranche loading on requester approval per stall, spend cap, three-tier decline ladder (card → M-Pesa till from same balance → requester-settled reimbursement from escrow), idempotency keys, void on close.

Trust & identity: tier 0–3 gating, tier-3 runner KYC (conduct, kin, movement), PII isolated to `kyc_case` with derived verification claims, entitlements as signed session claims.

Errand lifecycle: post → sealed blind auction (with direct-invite and relationship bypass) → stall-by-stall photography → approve/substitute/decline → QR handover → settle. Retake once, escalate on second failure.

Exceptions & safety: SOS case with location + identity snapshot, escrow freeze on pre-settlement report, Legal Ops as sole authority to split or reverse, evidence pack in ops console.

Ops: KYC queue, dispute queue with evidence, ruling log (desktop, restricted).

Product surface: EN/SW, 44px targets, timers (30 m / 1 h / 2 h / by 6pm) with 50 KSh on-time bonus, batching (each errand keeps its own card), chat, requester wallet float.

**Blanks — not yet designed**

1. **Runner earnings side.** No runner wallet, payout/cash-out to M-Pesa, fee or take-rate model, or earnings history. The runner only ever spends; they never get paid in the current build.
2. **Pricing.** How the guide ceiling is computed, whether surge exists, tipping.
3. **Cancellation and no-show.** Who bears cost when a requester cancels mid-run, a runner abandons, or a timer simply expires. Penalties undefined.
4. **Reputation.** Relationship rows exist, but there is no rating input, score, or effect on matching.
5. **Connectivity.** Behaviour offline or on thin data — photo upload queueing, USSD/SMS fallback, notifications channel.
6. **Vendor side.** Stalls are strings, not entities; till payment assumes a registered M-Pesa till that may not exist.
7. **Compliance.** Kenya DPA 2019 obligations, evidence retention window, KYC data deletion.
8. **Ops beyond disputes.** No fraud/anomaly monitoring, card controls (freeze/reissue), supply-demand view, or metrics.
9. **First-run and empty/error states.** Onboarding, zero-bid state, zero-runner-in-area state.

Biggest of these is runner earnings — the economics don't close without it. Want me to take that on next, or build this as a one-page coverage map you can circulate?

## User

act as a senior full-stack engineer building a production-ready startup MVP. Start by designing the complete architecture, then create the scalable version. Include; 1. System architecture 2. File structure 3. Database Schema 4. API endpoints 5. UI architecture 6. Production-ready code

## Assistant

_[tool: read_skill_prompt]_

_[tool: update_todos]_

_[tool: write_file]_

## Assistant

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

## Assistant

_[tool: write_file]_

## Assistant

_[tool: write_file]_

_[tool: write_file]_

_[tool: run_script]_

## Assistant

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: update_todos]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: copy_files]_

_[tool: present_fs_item_for_download]_

_[tool: update_todos]_

Package is above. Six documents plus twelve production TypeScript files.

Stack: TypeScript monorepo, Fastify + Postgres 16 + Drizzle, BullMQ workers, React Native (Expo), Next.js console, deployed af-south-1 for DPA residency. Modular monolith, not microservices — the money path spans four modules that must share a transaction.

Three things in the code worth reading first: the **transactional outbox** (jobs commit with their data, so Redis can't lose a tranche), the **posting ledger** with a deferred sum-to-zero constraint, and `decline-ladder.ts` with its test file — the ladder is a pure function so the rule can't drift.

Two things I decided rather than asked: platform fee at 12% (config, not literal) and a KSh 150 cancellation fee cap. Both are guesses; correct them in `config/env.ts`.

The gaps from the last round are still gaps — runner payouts are now schema'd and endpointed but the earnings UI isn't specified, and pricing/guide-ceiling logic has no home in the code. Say the word and I'll design those next.

## User

validate the geospacial mapping featr

## Assistant

_[tool: local_ls]_

_[tool: local_ls]_

_[tool: local_read]_

_[tool: local_read]_

Read the H3 source you attached (Uber's C library, v4.1). Validating our geo design against it:

**Two real defects in what I spec'd**

1. **No runner location anywhere.** The schema has no `runner_location` table, but `GET /feed` promises "open errands within radius, ranked." There is nothing to compute that radius from. Tier-3 `movement_consent` exists as a flag with no data behind it.
2. **GIST index on the wrong column.** I indexed `errand.dropoff` only. The feed matches runners to the *market*, which is `pickup` — and `pickup` is nullable with no index. Every feed query would seq-scan.

**On adopting H3**

It fits our aggregation needs, not our radius query. Worth being precise about which:

- **Good fit:** supply/demand heatmaps in the ops console, market catchment buckets, batching eligibility ("same market" becomes "same res-9 cell"), and privacy-preserving runner presence — store the cell, not the point.
- **Bad fit:** "runners within 3 km." `gridDisk` returns a hexagonal region, not a circle, and `gridDistance` is a hop count that can outright fail when two cells are separated by pentagonal distortion. PostGIS `ST_DWithin` on a geography column stays the correct primitive for the feed.

**Resolution, if we do adopt it.** Res 8 averages 0.74 km² with a ~531 m edge — roughly a Nairobi market's catchment, right for batching and heatmaps. Res 9 is 0.105 km², ~201 m edge — right for stall-level clustering and for coarsening a runner's live position before it's stored.

**Caveats to write into the spec, not discover later.** There are exactly 12 pentagons at every resolution; check with `getPentagons` that none land near our operating area. Hexagon areas vary by nearly 2× (max/min ratio 1.9927 at res 8+), so a cell count is not an area measure. All published areas assume a spherical authalic-radius model.

Want me to fix the schema — add `runner_location` with an H3 cell column plus the corrected GIST index — or write this up as a section in the architecture doc first?

## User

write this up as a section in the architecture doc first. Then add (runner_location) with an H3 cell column plus the corrected GIST index. Allow task to link the quester and runner even while the runner is offline through a shared key

## Assistant

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: write_file]_

_[tool: present_fs_item_for_download]_

Written up and implemented.

**Doc** — `01-architecture.md` gains §1.8 Geospatial model (PostGIS for "how far", H3 for "where roughly"; res 8 / res 9 assignments; the pentagon, area-variance and spherical-model caveats; explicit ban on H3 for radius and distance) and §1.9 the errand link key.

**Schema** — `runner_location` with `point` + `cell_r9` + `cell_r8`, derived by trigger; `runner_location_history` that keeps the cell and drops the point at 30 days; corrected GIST index on `errand.pickup` (partial, `status = 'open'`) alongside the dropoff one.

**Shared key** — minted at award, hash-only on the server, plaintext to both devices once. The requester's QR is an HMAC over `(errand_id, 30s step)`; the runner validates it on-device with a ±1 step window and queues a `handover_claim`, unique on `(errand_id, time_step)` so a replay can't settle twice. `code/domain/errand/link-key.ts` has both verification paths.

One thing I decided: a rejected late claim opens a dispute rather than failing quietly — by then the goods have moved. Change it if you'd rather it just fail.

The DC architecture doc still describes the old QR-token-only handover. Want me to mirror these two sections into it?

## User

There is a QR token on goods handover to release the task and save logs back to the server. But then, I have introduced a new hashed token that works like a handshake to secure the requester and runner share location data for better seurity

## Assistant

_[tool: str_replace_edit]_

_[tool: grep]_

_[tool: run_script]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: write_file]_

_[tool: delete_file]_

_[tool: present_fs_item_for_download]_

Corrected — I'd wrongly repurposed the key for handover. Now the two are separate:

**QR token** — unchanged. Requester displays, runner scans, task releases, logs write back to the server.

**Link handshake** — X25519 keys exchanged at award; both sides derive a shared secret and independently compute `link_hash = SHA-256(pub_R ‖ pub_N ‖ errand_id)`. The server stores only that hash, so it can confirm both sides reached the same value without ever holding the secret. Sharing stays refused until both acks land.

Every position fix carries `HMAC(secret, fix ‖ errand_id ‖ seq)`, verified on the *receiving device* — a forged or replayed fix is discarded before it reaches a map. Monotonic `seq` blocks stale re-sends.

Because the hash is derived rather than issued, it survives both parties going offline: the requester's screen shows `linked_stale` with the last verified fix and its age, never "unknown", and the runner's queued fixes upload in `seq` order and all still verify.

Files touched: `01-architecture.md` §1.9, `03-schema.sql` (`errand_link` + `errand_link_active` view; `runner_location` gains `seq`, `hmac_tag`, `detail_enc`), `04-api.md`, and `code/domain/errand/link-handshake.ts`.

One limit stated plainly in the doc: the platform still reads the point and cell it needs for matching, so this is authenticity and scoping, not confidentiality from the platform.

## User

Let's run through the following checkpoints to see if we have the app ready for deployment. A requester opens the app; posts the task he/she wants to give out, sees a number of registered/verified runners on the map and picks from the cluster. Break the system into multiple sub-systems. 1. LOCATION: The backend takes multiple Ingest reports from runners within a relative 3km location. This requires geospatial querying for faster timings. 2. LOGISTICS: The requester picks a runner, and they agree upon the task and fee set. The requester is prompted to load up the virtual card with the total amount agreed either via m-pesa or from their bank or credit/debit card. 3. CONCURRENCY: If two runners pick the same task at the same time, the backend should have an atomic update that assigns the trip to only one through First-Write wins. 4. Both devices start streaming location data simultaneously to each other prompting the backend to channel recent location through fast temporary storage while trip events/logs are pushed to the database. 5. ETA: We need an engine that will keep track of runner's progress on task durations, current location and activities achieved. 6. PRICING: The service fee ought to be structured from both demographics. The percentage will be divided be half and expected from both parties. Firstly, a portion added to the prompt as service cost when depositing and a maintenance fee as funds are being disbursed to the runner.  The architecture should be split into several services to manage failure. No two systems should go down at the same time. They should all communicate through events and queues without manifesting into giant requests.

## Assistant



## Assistant

This is a redesign — several checkpoints reverse decisions already built. Quick verdict first, then I need four things settled before I rebuild.

**1. Location** — mostly there. `runner_location` carries point + res-8/9 cells, GIST index, `ST_DWithin` for the 3 km query, H3 res 8 for map clustering. Missing: the reverse query (we have *errands near a runner*, not *runners near a requester*), an ingest rate/batching policy, and there is no map screen anywhere in the app design.

**2. Logistics** — conflicts. We load the card *in tranches after each stall approval*; you're describing the full agreed amount upfront. Also, only M-Pesa is designed. Bank and card rails mean a PSP, 3DS, and a settlement account — none of that exists in the spec.

**3. Concurrency** — the mechanism is built, pointed the other way. Single-winner election on `awarded_bid_id` covers *requester awards*. Runner-races-to-accept is the same one-line trick on `runner_id`. But it contradicts checkpoint 1, where the requester picks.

**4. Streaming** — half. Handshake, HMAC-tagged fixes and offline queueing are done. No Redis hot tier (fixes currently go straight to Postgres), and it's one-directional — nothing streams requester→runner.

**5. ETA** — nothing. No schema, no service, no endpoints.

**6. Pricing** — conflicts. One fee, taken from the runner at settlement. Yours is two-sided and split across two moments. The ledger's `settle()` needs reworking.

**7. Service split** — reverses my recommendation. The outbox already makes it possible, but today stall approval holds escrow, writes the tranche and enqueues the load in *one transaction*. Split across services that becomes a saga with compensations. That's the largest cost on this list, and worth being deliberate about.

Also, plainly: "no two systems down at the same time" isn't achievable as stated. Blast-radius isolation is — I'll design for that and name the shared dependencies that remain.

_[tool: ask_user]_

Waiting on those eight. The assignment model and the card-funding question are the two that decide whether this is a rework of the money core or an addition alongside it — once I have them I'll write the service split, the ETA engine, and the two-sided fee into the architecture and schema.

## User

Answered — assignment: Both: requester can pick, or open it to first-accept; funding: Upfront for fixed-price tasks, tranches for market runs; rails: M-Pesa STK push, M-Pesa paybill, Bank transfer, Card (Visa/Mastercard), Platform wallet balance; fee_split: One total fee, split 50/50 — each side bears half; fee_rate: 12; eta_source: Checkpoint-based: stalls completed vs remaining, no map routing; services: 6-8 services; timeline: pilot testing within 2-3 weeks and publicly launched by the start of next month

## Assistant

_[tool: update_todos]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: str_replace_edit]_

_[tool: update_todos]_

_[tool: present_fs_item_for_download]_

Built to your answers. New: `06-services.md`, `03b-schema-v2.sql`, and three domain files (`pricing/fees.ts`, `progress/eta.ts`, `api/routes/assignment.routes.ts`).

**Seven services**, event-driven over Redis Streams with a per-service outbox. One exception I'd defend hard: `money` keeps ledger, escrow, card and tranches together, because stall approval is one `SERIALIZABLE` transaction across all four. Split, it becomes a saga whose failed compensation leaves real money in an unknown state.

**Both assignment modes** run through a single conditional `UPDATE ... WHERE runner_id IS NULL`. `pick` adds `AND offered_to = $runner`; `open` doesn't. Zero rows means you lost.

**Both funding modes** share one code path — an upfront load is a tranche at seq 0, so there's one ledger shape and one decline ladder.

**Fees**: 12% of the runner's fee, 6% each side, base is the fee not the goods. Bonus and reimbursements aren't fee-bearing. The odd cent goes to the requester's half, so the runner never loses one to rounding.

**Two things you should push back on if you disagree:**

The timeline doesn't hold. Five rails in 2–3 weeks isn't a software problem — card and bank each need a PSP contract, sandbox certification and a settlement account. §6.11 stages it: pilot on M-Pesa STK + wallet, add paybill at launch, card and bank when the PSP work lands. Cut rails, not isolation.

And "no two systems down at once" isn't achievable as written. One Postgres cluster and one Redis stay shared. I've documented the per-service degraded modes and named the shared dependencies rather than claiming otherwise.

## User

Security and scale should be our next agenda items.

## Assistant

_[tool: write_file]_

_[tool: write_file]_

_[tool: str_replace_edit]_

_[tool: present_fs_item_for_download]_

Two new documents.

**Security** — threat model by actor (malicious runner, requester, outsider, insider), money-path velocity limits and nightly reconciliation, location privacy as enforceable rules, GPS spoofing as its own section since the HMAC doesn't touch it, DPA 2019 launch blockers, and a closing list of what we're knowingly accepting.

**Scale** — the arithmetic changed my mind on one thing worth flagging: at year-one volume the money path runs **0.7 writes per second**. The `SERIALIZABLE` approval transaction we debated splitting is never going to be the bottleneck. Location is, at ~266 fixes/s and 2.3 GB/day. That three-order-of-magnitude gap is the real justification for the service split.

Three things you should act on before they're urgent:

**Issuer per-card fees.** One card per errand at 20,000 errands/day is 600,000 cards a month. At $0.05 each that's $30,000/month. Negotiate this before the model is locked — the fallback (pooled card per runner per day) is a materially different design and should be evaluated now, not later.

**PgBouncer at launch, not when it breaks.** Seven services will exhaust Postgres connections long before CPU.

**Legal Operations staffing.** One officer can't adjudicate disputes proportional to 20,000 errands a day. That's the ops console's real ceiling, and it's a hiring problem, not an engineering one.

Load assumptions are in §8.1 — 50 / 500 / 10,000 runners. Correct them if they're off; every number downstream moves.

