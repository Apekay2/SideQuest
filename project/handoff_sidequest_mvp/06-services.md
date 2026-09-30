# 6. Service split

Seven services plus the ops console. This supersedes the modular monolith in §1.1; §1.2's
module list becomes the map of what lives where.

## 6.1 The services

| Service | Owns | Why it is its own deployable |
| --- | --- | --- |
| `identity` | Accounts, OTP, sessions, KYC, tiers, entitlements | Auth traffic is spiky and read-heavy; it must survive everything else being down |
| `errand` | Lifecycle, assignment, basket, evidence, chat | The busiest write path that is not money |
| `location` | Fix ingest, geo queries, hot store, link handshake | Highest write volume by an order of magnitude; needs its own scaling curve |
| `money` | Ledger, escrow, card, tranches, fees | **Deliberately one service.** See 6.2 |
| `payments` | M-Pesa STK and paybill, bank transfer, card PSP, all webhooks | Isolates five third parties whose failures are unrelated to each other and to us |
| `progress` | Checkpoints, ETA engine, timers, on-time bonus | Pure computation over events; can be restarted at will |
| `notify` | Push, SMS, USSD fallback, templating | Slow third parties must never be in a request path |
| `ops-console` | Staff UI (Next.js) | Internal, different auth, different network |

Each service owns a **Postgres schema** and no other service may read it. Cross-service reads
go through events or a synchronous call to the owner.

## 6.2 What must not be split

`money` holds ledger, escrow, card and tranches together because one operation spans all four:

```
approve stall  →  hold escrow  +  write tranche  +  enqueue card load
```

Today that is one `SERIALIZABLE` transaction. Split across services it becomes a saga with
compensating actions, and a compensation that fails leaves real money in an unknown state. The
cost of keeping these four together is that `money` is the largest service. The cost of
separating them is a class of bug you cannot test your way out of. Keep them together.

The same reasoning is why `payments` is separate but *subordinate*: it owns the rails and the
webhooks, and it emits events. It never writes to the ledger. `money` is the only writer.

## 6.3 Events

Redis Streams, one stream per publishing service, consumer groups per subscriber. Each service
has its own `outbox_event` table in its own schema and its own poller — the pattern from §1.3,
applied seven times. A service never publishes from inside a request; it commits an outbox row.

| Event | Published by | Consumed by |
| --- | --- | --- |
| `account.tier_changed` | identity | errand, money |
| `errand.published` | errand | location, notify |
| `errand.offer_made` | errand | notify |
| `errand.assigned` | errand | money, location, progress, notify |
| `errand.checkpoint` | errand | progress |
| `stall.submitted` | errand | notify |
| `stall.approved` | errand | money |
| `tranche.loaded` / `tranche.failed` | money | errand, notify |
| `escrow.funded` | money | errand |
| `payment.confirmed` / `payment.failed` | payments | money |
| `payout.confirmed` | payments | money, notify |
| `location.fix_batch` | location | progress |
| `link.established` / `link.revoked` | location | errand |
| `eta.updated` | progress | notify |
| `errand.settled` | money | errand, location, progress, notify |

Every event carries `{ id, type, occurred_at, actor_id, errand_id?, payload, version }`.
Consumers are idempotent on `id` — a `consumed_event` table per service, primary key on the
event id, inserted in the same transaction as the effect.

**No event carries money amounts as instructions.** `stall.approved` says which stall was
approved; `money` reads its own copy of the amount. An event that told another service how many
cents to move would be a second source of truth.

## 6.4 Failure isolation

"No two systems down at the same time" is not achievable — anything sharing a dependency shares
a failure. What is achievable is bounded blast radius, and being honest about what remains
shared.

| If this fails | What still works | What stops |
| --- | --- | --- |
| `payments` | Everything except new funding and payouts. Errands in flight complete on already-loaded cards | Top-ups, cash-outs |
| `location` | Posting, assignment by pick from last known positions, approvals, settlement | Live tracking, 3 km discovery, new handshakes |
| `progress` | All of it | ETA display, on-time bonus adjudication (bonus defaults to granted) |
| `notify` | All of it; users see state by polling | Push and SMS |
| `errand` | Wallet, payouts, ops | Posting, assignment, approvals |
| `money` | Browsing, chat, tracking | Any approval or settlement. Errands hold |
| `identity` | Sessions already issued keep working for 15 minutes | New logins |

**Shared dependencies that remain, stated plainly.** One Postgres cluster with a schema per
service, and one Redis. A cluster failover takes everything down for 60–90 seconds. Splitting
into seven clusters before a pilot buys less than it costs; revisit after launch. The mitigation
is Multi-AZ synchronous replication, and `location`'s hot tier living in Redis so live tracking
survives a Postgres failover untouched.

Every service ships with: its own health endpoint, a circuit breaker on each outbound
dependency, a bulkhead limiting concurrent calls to any one peer, and a documented degraded
mode. A service that cannot reach a peer degrades; it does not queue requests until it dies.

## 6.5 Subsystem 1 — LOCATION

**Ingest.** Runners emit a fix every 15 s while on an errand, every 60 s while idle-and-available.
The app batches up to 4 fixes per request. `location` writes to Redis first, then batches to
Postgres every 30 s.

```
Redis   loc:cur:{runnerId}          → latest fix, TTL 120 s
        loc:trail:{errandId}:{role} → capped list, last 200 fixes, TTL 6 h
        loc:cell:{cellR8}           → sorted set of available runners, TTL 120 s
Postgres runner_location            → current row, upserted from the batch
         runner_location_history    → append-only trail
```

The Redis cell set is what makes discovery fast: the requester's res-8 cell and its six
neighbours give a candidate list without touching Postgres, and only that shortlist gets an
exact `ST_DWithin` check.

**The 3 km query.** Two steps, in this order:

```sql
-- 1. Candidates from H3 (cheap, in Redis or Postgres)
--    h3_grid_disk(requester_cell_r8, 1) covers ~1.6 km of margin around 3 km
-- 2. Exact filter — this is what decides visibility
SELECT rl.runner_id,
       ST_Distance(rl.point, $origin) AS metres
  FROM runner_location rl
  JOIN account a ON a.id = rl.runner_id
 WHERE rl.is_online
   AND rl.cell_r8 = ANY($cells)
   AND a.verification_tier >= 3
   AND a.suspended_at IS NULL
   AND rl.received_at > now() - interval '2 minutes'
   AND ST_DWithin(rl.point, $origin, 3000)
 ORDER BY metres
 LIMIT 50;
```

H3 narrows; PostGIS decides. Never the reverse — a `gridDisk` is a hexagon, not a circle.

**Map clustering.** The requester's map groups runners by res-9 cell at close zoom and res-8 at
far zoom, so a cluster is a stable geographic bucket rather than a pixel-distance grouping that
reshuffles on every pan.

## 6.6 Subsystem 2 — LOGISTICS

**Two assignment modes**, set per errand at publish (§6.7 covers the race).

- `pick` — the requester sees verified runners on the map and offers the task to one. The runner
  has 90 seconds to accept. On decline or timeout the offer lapses and the requester picks again.
- `open` — the errand goes to the feed and the first runner to accept gets it.

**Two funding modes**, defaulted from the errand kind and overridable:

| Kind | Mode | Behaviour |
| --- | --- | --- |
| `market_run` | `tranche` | Card loads per stall on approval. Unchanged from §1.3 |
| `queue_stand`, `document_drop`, `custom` | `upfront` | Full agreed amount loaded at assignment; runner spends against it freely |

`upfront` is safe for these kinds precisely because the amount is known before anyone starts.
The tranche machinery still runs underneath — an upfront load is a single tranche at seq 0 — so
there is one code path, one ledger shape and one decline ladder.

**Funding rails.** All five at launch, behind one `PaymentRail` port in `payments`:

| Rail | Mechanism | Confirmation |
| --- | --- | --- |
| M-Pesa STK push | Daraja STK | Webhook, 5–90 s |
| M-Pesa paybill | Daraja C2B | Webhook, user-initiated |
| Bank transfer | PSP virtual account per user | Webhook, minutes to hours |
| Card | PSP hosted page, 3DS2 | Webhook, seconds |
| Wallet balance | Internal | Synchronous |

Only the wallet rail is synchronous. Every other rail leaves the errand in `awaiting_funds` with
a live status, and the app must show a rail-appropriate wait — a card is seconds, a bank
transfer can be tomorrow.

## 6.7 Subsystem 3 — CONCURRENCY

One pattern, applied in both modes:

```sql
UPDATE errand
   SET runner_id = $runner, status = 'awarded', assigned_at = now()
 WHERE id = $errand
   AND runner_id IS NULL
   AND status IN ('open', 'offered')
RETURNING id;
```

Zero rows returned means someone else won. The loser gets `409 ALREADY_ASSIGNED` and the feed
refreshes. No distributed lock, no Redis mutex, no advisory lock — a single conditional update
is atomic and is the whole mechanism.

In `pick` mode the same statement runs with an added `AND offered_to = $runner`, so only the
invited runner can take it, and the 90-second lapse is a scheduled job that clears `offered_to`
and returns the errand to `open`.

## 6.8 Subsystem 4 — BIDIRECTIONAL STREAMING

Once the link handshake is active (§1.9), both devices stream. Fixes go to Redis on arrival and
fan out over WebSocket to the counterpart; the durable trail batches to Postgres every 30 s.

```
device → POST /location (batch of ≤4)
       → location: verify HMAC, write Redis, fan out to peer socket
       → every 30 s: flush to runner_location_history, emit location.fix_batch
```

Trip events — assignment, arrival, stall submitted, approval, handover — go straight to
Postgres through `errand`, never through the hot tier. Positions are ephemeral and lossy by
design; events are not.

**Retention.** Redis trail 6 hours. Postgres points 30 days, then nulled with the res-9 cell
kept. This is the §1.8 policy, unchanged.

## 6.9 Subsystem 5 — ETA

Checkpoint-based, no routing provider. Progress is a weighted sum of reached checkpoints;
remaining time is the sum of median observed durations for the checkpoints still ahead.

```
checkpoints: assigned → en_route → arrived → [per stall: submitted → approved] → handover
```

Medians are learned per `(errand_kind, market cell_r8, hour bucket)` and fall back to a global
median per checkpoint until there are 20 samples in a bucket. Cold-start medians ship as seed
data and are visibly labelled as estimates in the UI until real data replaces them.

Location is used only as a **corroborating signal**: if the runner's last fix is within 200 m of
the market and `arrived` has not fired, `progress` raises confidence that arrival is imminent;
it never invents a checkpoint. A stale fix widens the confidence band rather than freezing the
ETA.

Output per errand: `{ percent_complete, eta_at, confidence: high|medium|low, stale_since }`.
`low` confidence shows a range, not a time. The on-time bonus adjudicates on the handover
timestamp against `deadline_at` — never on the ETA.

## 6.10 Subsystem 6 — PRICING

Total platform take is **12% of the runner's fee**, split evenly: **6% from each side**. The
base is the service fee, not the goods — the platform does not take a percentage of somebody's
groceries.

```
agreed runner fee          F
requester service fee      +6% of F   charged at deposit, on top
runner maintenance fee     −6% of F   deducted at disbursement

requester pays   F + 0.06F  (+ goods, for market runs)
runner receives  F − 0.06F  (+ any reimbursement, + bonus in full)
platform keeps   0.12F
```

Both halves are separate ledger postings at separate moments, so a refund before assignment
returns the requester's 6% and never touches the runner's. The on-time bonus is not fee-bearing:
the runner receives all 50 KSh. Reimbursements are not fee-bearing either — taking a cut of
money the runner already spent out of pocket would be indefensible.

Rounding is banker's-rounding to the cent, computed once at deposit and once at disbursement,
never re-derived from a percentage at display time.

## 6.11 Deployment reality against the timeline

Pilot in 2–3 weeks, public launch at the start of next month, seven services, five payment
rails. Two of those cannot both be true. The rails are the binding constraint: card and bank
each need a PSP contract, sandbox certification and a settlement account, and neither is a
software task you can compress.

What fits the pilot window, in order:

1. **Pilot (weeks 1–3):** M-Pesa STK and wallet only. Services `identity`, `errand`, `money`,
   `location`, `notify` deployed; `payments` present but with one rail; `progress` running with
   seed medians and its ETA hidden behind a flag. Assignment `pick` only.
2. **Launch (week 4–6):** add `open` assignment, M-Pesa paybill, ETA visible, `progress`
   collecting real medians.
3. **Post-launch:** card and bank rails as the PSP work lands. Split Postgres per service if
   load justifies it.

Shipping seven services in three weeks is achievable because they share a repo, a deploy
pipeline and a database cluster. Shipping five rails is not. Cut the rails, not the isolation.
