# 1. System architecture

## 1.1 Shape

A modular monolith deployed as one Fastify process, plus a worker process, plus Postgres and
Redis. Thirteen domain modules with enforced import boundaries — a module may only be reached
through its `index.ts`, checked in CI by `dependency-cruiser`. Each module is a service in
waiting: when one needs its own scaling profile, it lifts out behind the same interface.

Do not start with microservices. A four-person team cannot operate thirteen deployables, and
the money path spans four modules that must share a transaction.

```
                      ┌──────────────────────────────┐
   React Native ──────▶                              │
   Next.js console ───▶   Fastify API (ECS service)  │──▶ Postgres 16 (RDS, Multi-AZ)
   Daraja webhooks ───▶                              │──▶ Redis 7 (ElastiCache)
   Issuer webhooks ───▶                              │──▶ R2 (evidence objects)
                      └───────────────┬──────────────┘
                                      │ BullMQ
                      ┌───────────────▼──────────────┐
                      │   Worker (ECS service)       │──▶ Daraja  (STK, B2C, C2B)
                      │   auction, tranche, settle,  │──▶ Issuer  (card create/load/void)
                      │   payout, sweeper, notify    │──▶ Africa's Talking (SMS/USSD)
                      └──────────────────────────────┘
```

## 1.2 Modules

| Module | Owns | Synchronous? |
| --- | --- | --- |
| `identity` | Accounts, OTP, sessions, entitlement claims | yes |
| `kyc` | Documents, tiers 0–3, ops review queue | no (review is async) |
| `errand` | Errand lifecycle state machine, spend cap | yes |
| `auction` | Sealed bids, close timer, award | mixed |
| `matching` | Candidate runners, relationships, direct invites | yes (read-only) |
| `basket` | Stalls, line items, substitutions | yes |
| `evidence` | Photo upload, retake counter, escalation | yes |
| `card` | Issuance, tranche load, void, decline ladder | no (durable) |
| `ledger` | Double-entry accounts and postings | yes (in-transaction) |
| `escrow` | Fund, hold, freeze, release, split | yes (in-transaction) |
| `payout` | Runner earnings, B2C disbursement | no |
| `dispute` | Cases, evidence packs, Legal Ops rulings | yes |
| `notify` | Push, SMS, USSD fallback, templating | no |

**Rule:** anything a user waits on is synchronous. Anything touching money or a third party is
a durable job with retries, even when it looks fast.

## 1.3 The money path

The single most important flow. It is worth reading `code/domain/card/tranche.ts` alongside.

```
requester approves stall N
        │
        ▼
POST /errands/:id/stalls/:stallId/approve      (synchronous, returns 202)
        │
        ├─ tx: validate stall total ≤ remaining spend cap
        ├─ tx: insert tranche row (status=pending, seq=N, idem_key)
        ├─ tx: ledger hold escrow → errand_card_float
        └─ enqueue card.load { trancheId }      ← same tx via transactional outbox
        │
        ▼
worker: card.load
        │
        ├─ issuer.loadCard(cardId, amount, idemKey)
        ├─ on success  → tranche.status = loaded, push "spend now" to runner
        ├─ on decline  → decline ladder (below)
        └─ on timeout  → retry with same idemKey, 5 attempts, exp. backoff
```

The **transactional outbox** is what makes this safe. The job is not enqueued to Redis inside
the request; a row goes into `outbox_event` in the same transaction as the ledger hold, and a
poller moves it to BullMQ. Redis being down cannot lose a tranche, and a rolled-back approval
cannot leave a job that loads a card for money that was never held.

### The decline ladder

Three tiers, tried in order, each with a hard stop.

1. **Card retry.** One retry with the same idempotency key. Covers issuer flake.
2. **M-Pesa till.** Pay the vendor's till by B2C from the errand's own held balance. Requires
   the stall to have a `till_number`; without one, skip to 3.
3. **Requester-settled reimbursement.** Runner is told to pay cash. A `reimbursement` posting
   is written against escrow and settled to the runner at errand close. Capped at
   `min(stall_total, remaining_cap)` and requires an explicit requester confirmation push;
   without confirmation inside 5 minutes the errand escalates to a decision card.

Every rung writes an `card_attempt` row. The ops console reads that table directly; it is the
only account of what actually happened to the money.

## 1.4 Concurrency and correctness

- **Ledger writes run at `SERIALIZABLE`.** Postings are appended, never updated. A
  `sum(amount) = 0` per `posting_group` check runs as a deferred constraint trigger.
- **Errand state transitions take a row lock** (`SELECT … FOR UPDATE` on `errand`) and are
  validated against an explicit transition table in `code/domain/errand/machine.ts`. An
  invalid transition throws, it does not warn.
- **Auction close is a single-winner election.** `UPDATE errand SET awarded_bid_id = $1 WHERE
  id = $2 AND awarded_bid_id IS NULL RETURNING id` — the losing worker gets zero rows and
  exits. No distributed lock needed.
- **Idempotency keys are stored, not just sent.** `idempotency_key` is a unique index on
  `card_attempt` and `payout_attempt`; a duplicate insert is caught and the stored response
  replayed.

## 1.5 Failure posture

| Failure | Behaviour |
| --- | --- |
| Issuer down | Tranche retries 5× over 8 minutes, then decline ladder rung 2 |
| Daraja down | Escrow funding queues; errand stays `awaiting_funds`, requester sees a banner |
| Redis down | API serves reads and writes; jobs accumulate in `outbox_event` and drain on recovery |
| Postgres failover | 60–90s of 503s; clients retry with backoff, no data loss (Multi-AZ sync) |
| Runner offline mid-run | Photos queue on device, upload on reconnect; timer pauses after 10 min of silence and notifies the requester |
| Push undelivered | Falls back to SMS after 60s, then USSD callback for tier-critical prompts |

## 1.6 Security and compliance

- All PII in `kyc_case`, encrypted at rest with a KMS-managed key, column-level via `pgcrypto`
  for document numbers. Retention 7 years for settled cases, 90 days for rejected ones.
- Data resident in `af-south-1` (Cape Town). Kenya DPA 2019 registration required before
  launch; the DPO contact is a launch blocker, not a nice-to-have.
- Entitlements are signed claims in a 15-minute JWT. The gateway rejects an unentitled write
  without touching the database.
- Evidence objects are private; the app receives 5-minute presigned URLs. Ops console reads
  through a proxy route that writes an access audit row.
- Rate limits: 5 OTP/hour/number, 60 writes/minute/account, 300 reads/minute/account.

## 1.7 Non-functional targets

| Metric | Target |
| --- | --- |
| API p95 (read) | 180 ms |
| API p95 (write) | 400 ms |
| Tranche load, approval → runner notified | p95 6 s, p99 20 s |
| Auction close accuracy | ±2 s of scheduled time |
| Evidence upload, 3G, 1.5 MB | p95 12 s with client-side resize to 1280px |
| Availability | 99.5% month, money path 99.9% |
| RPO / RTO | 5 min / 30 min |

## 1.8 Geospatial model

Two primitives, used for different questions. Confusing them is the usual way a marketplace
gets a slow feed and a wrong heatmap at the same time.

**PostGIS answers "how far".** `geography(Point,4326)` with a GIST index, queried with
`ST_DWithin`. This is what the runner feed uses, and it is the only thing allowed to decide
whether a runner is near enough to see an errand. It is metric, it is exact, and it does not
care about grid topology.

**H3 answers "where, roughly, and how many".** Uber's hexagonal hierarchical index
(`h3-pg` extension, `h3index` column type). Used for bucketing and aggregation only:

| Use | Resolution | Cell size |
| --- | --- | --- |
| Ops supply/demand heatmap, market catchment | 8 | avg 0.74 km², ~531 m edge |
| Batching eligibility ("same market"), coarsened runner presence | 9 | avg 0.105 km², ~201 m edge |

Res 8 is about the size of a Nairobi market's catchment, which is why batching and the heatmap
sit there. Res 9 is the granularity we store a runner's live position at — fine enough to match,
coarse enough that a stored history is not a movement log of an individual.

### What H3 must not be used for

- **Radius search.** `gridDisk(origin, k)` returns a hexagonal region, not a circle. At res 8
  a `k`-ring approximates a `k × 531 m` radius while over-covering the corners and
  under-covering the edges. Use `ST_DWithin`.
- **Distance.** `gridDistance` is a hop count, not metres, and it fails outright when two cells
  are separated by pentagonal distortion. It is not a metric and must never back a "3 km away"
  label.

### Caveats to hold in mind

- There are exactly **12 pentagons at every resolution**, centred on the icosahedron vertices.
  Run `getPentagons` for res 8 and 9 during setup and assert none fall within the Kenya
  bounding box; if one ever does, cell-count statistics in that area are not comparable.
- Hexagon areas vary by nearly **2×** within a resolution (max/min ratio 1.9927 at res 8 and
  finer). A cell count is a count, never an area or a density.
- Published areas and edge lengths assume a **spherical** earth at the WGS84 authalic radius.
  Fine for bucketing; not a survey instrument.

### Runner presence

`runner_location` holds one current row per runner plus a coarse history, written only while
the runner is on an errand and only with tier-3 `movement_consent`. It carries both
representations: the exact point for `ST_DWithin`, and the res-9 cell for aggregation and for
the privacy-preserving reads the ops console gets. Rows older than 30 days keep the cell and
drop the point.

## 1.9 The link handshake — securing shared location

Handover is unchanged: the requester shows a rotating QR token, the runner scans it, the task
is released and the logs are written back to the server. That token's job is to end the errand,
and it needs the server.

The hashed token is a separate mechanism with a separate job: **it establishes, between one
requester and one runner, the right to see each other's location for one errand, and it proves
every position fix came from the phone it claims to.** It never releases a task and it never
moves money.

### The handshake

At award, both devices already hold a long-lived X25519 keypair in the platform secure store.

```
1. requester → server   pub_R
2. runner    → server   pub_N        (in the assignment response)
3. server relays each public key to the other side
4. both derive   secret = X25519(own_priv, other_pub)
                 link   = SHA-256(pub_R ‖ pub_N ‖ errand_id)
5. both POST /errands/:id/link/ack  with `link`
6. server stores `link` once, and marks each side acked
```

Step 5 is the handshake proof. The server holds only the hash, so it can confirm that two
devices independently arrived at the same value — which is only possible if both completed the
exchange for this errand — without ever holding the secret itself. Location sharing is refused
until both acks are in.

### What the secret protects

Every position fix a device emits is authenticated with the shared secret:

```
fix = { lat, lng, accuracy_m, heading_deg, recorded_at }
tag = HMAC-SHA256(secret, canonical_json(fix) ‖ errand_id ‖ seq)
```

The counterpart verifies the tag before it draws anything on a map. An injected or replayed fix
is discarded on the receiving device, not merely disbelieved by the server. `seq` is monotonic
per errand, so a stale fix cannot be re-sent to fake a stationary runner.

The detailed stream — heading, accuracy, the path between fixes — is additionally sealed to the
counterpart with the shared secret and stored by the platform as ciphertext. The platform keeps
in the clear only what it operationally needs: the point, for `ST_DWithin` matching, and the
res-9 cell, for aggregation.

**Say the limit out loud.** This is not confidentiality from the platform for the fields the
platform must read to run a marketplace. It is authenticity for every fix, a scope of exactly
one errand and exactly two people, and a hard end: the link is revoked at settlement, both
devices destroy the secret, and a revoked link makes every later fix unreadable.

### Working while the runner is offline

The link is the durable thing, not the connection. Because `link` is derived rather than
issued, it survives both parties being offline and it is the same value on both phones and on
the server. Three consequences:

- The requester's screen keeps showing the runner as **linked**, with the last verified fix and
  its age, rather than dropping to "unknown". A runner in a dead zone is a known runner whose
  position is stale, and the UI says so in those terms.
- The runner's device keeps capturing and tagging fixes into the outbound queue. On reconnect
  the whole run uploads in `seq` order and the requester's map fills in the gap, every fix
  still verifiable.
- Either side can reach the other by `link` alone after a reinstall, without the server
  re-issuing anything — the handshake is repeated from the stored keypairs and lands on the
  same hash.

Chat and evidence captured offline are queued the same way and stamped with `errand_id`, so a
conversation composed with no signal reassembles in order.

