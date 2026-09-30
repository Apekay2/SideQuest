# 8. Scale

Numbers first, because most scale documents are opinions with no arithmetic in them.

## 8.1 Assumed load

Correct these if they are wrong — every conclusion below moves with them.

| Stage | Runners | Concurrent on errand | Errands/day | When |
| --- | --- | --- | --- | --- |
| Pilot | 50 | 10 | 60 | Weeks 1–3 |
| Launch | 500 | 100 | 800 | Month 1–3 |
| Year one | 10,000 | 2,000 | 20,000 | Month 12 |

## 8.2 Where the load actually is

**Location ingest is the only firehose. Everything else is a rounding error.**

Runners emit a fix every 15 s while on an errand, every 60 s while idle-and-available.

```
Year one:  2,000 on errand   / 15 s  = 133 fixes/s
           8,000 idle        / 60 s  = 133 fixes/s
                                      ≈ 266 fixes/s   (~23 M/day)
```

Compare the money path at the same stage: 20,000 errands/day averaging 3 stalls is 60,000
approvals/day — **0.7 writes per second**. The `SERIALIZABLE` transaction that worried us in
§6.2 runs less than once a second at year-one volume. Do not optimise it. Do not split it.

The lesson to carry: `location` and `money` have load profiles that differ by three orders of
magnitude, which is the real reason they are separate services.

## 8.3 Location, in detail

**Write path.** Fixes land in Redis synchronously and batch to Postgres every 30 s.

```
Redis   266 writes/s across ~4 keys per fix        →  ~1,100 ops/s
        A single cache.t4g.medium handles ~50,000 ops/s. Headroom: 45×.

Postgres  266 fixes/s ÷ 30 s batching ≈ 9 COPY batches/s
          ~100 bytes/row × 23 M/day  ≈  2.3 GB/day of history
```

That storage figure is the one that bites. Three mitigations, in order of importance:

1. **Partition `runner_location_history` by day**, `PARTITION BY RANGE (recorded_at)`. Detach
   and archive to S3 at 30 days rather than running a `DELETE` that vacuums for hours.
2. **Null the point at 30 days, keep the cell.** Already policy (§1.8). A cell-only row is
   ~40 bytes, so the retained tail costs a quarter of what the full row does.
3. **Downsample on write.** Discard a fix that is within 20 m of the previous one and less than
   60 s newer. A runner standing in a queue produces no useful trail; at year one this removes
   an estimated 30–40% of rows outright.

**Read path.** The 3 km query is bounded by the H3 pre-filter, not by PostGIS. `h3_grid_disk(cell_r8, 1)`
returns 7 cells covering roughly 5 km across, which at year one is a candidate set in the low
hundreds even in central Nairobi; the `ST_DWithin` then runs on that, not on 10,000 rows. Keep
the partial GIST index (`WHERE is_online`) — it is what keeps the index small enough to stay in
memory.

The nearby endpoint is also the most cacheable thing in the system: cache by
`(cell_r9, radius bucket)` for 10 seconds. Two requesters a block apart get one query.

## 8.4 Database

One cluster, schema per service, until the numbers say otherwise.

| Stage | Instance | Storage | Read replicas |
| --- | --- | --- | --- |
| Pilot | db.t4g.medium | 100 GB gp3 | 0 |
| Launch | db.m7g.large, Multi-AZ | 500 GB gp3 | 1 |
| Year one | db.m7g.2xlarge, Multi-AZ | 4 TB gp3 | 2 |

**Connection pooling is not optional past the pilot.** Seven services × several instances each
will exhaust Postgres connections long before they exhaust its CPU. PgBouncer in transaction
mode, one pool per service, sized at 20. Note the constraint this imposes: transaction-mode
pooling forbids session state, so no `SET` outside a transaction and no advisory locks held
across statements — neither of which we use, and both of which someone will eventually try.

**Read replicas serve** the feed, the ops console and analytics. They must never serve the
money path: a replica lag of 200 ms is enough for a requester to approve a stall against a
stale cap.

**Partition** `runner_location_history` (daily), `posting` (monthly), `errand_checkpoint`
(monthly), `audit_log` (monthly). Everything else stays whole through year one.

**Index discipline.** The partial indexes in the schema (`WHERE status = 'open'`,
`WHERE is_online`, `WHERE dispatched_at IS NULL`) are doing real work — an unqualified index on
`errand(status)` would be an order of magnitude larger and would not fit the hot set. Resist
adding broad indexes "just in case"; every one of them is paid for on every write.

## 8.5 Queues and events

Redis Streams, one per publishing service, consumer groups per subscriber.

At year one the busiest stream is `location.fix_batch` at roughly 9 messages/s. This is not a
scaling problem; it is a *correctness* problem, and the two controls that matter are:

- **Consumer lag alarms** per group. A `progress` consumer that falls 5 minutes behind is
  producing ETAs from stale checkpoints, and nobody will notice from a dashboard of CPU.
- **A dead letter stream** per consumer group. A poison message that a consumer retries forever
  is the most common way an event-driven system stops without going down.

Outbox pollers tick every 250 ms with `FOR UPDATE SKIP LOCKED`, so adding worker instances is
the entire scaling strategy for dispatch.

## 8.6 API tier

| Stage | API tasks | Worker tasks |
| --- | --- | --- |
| Pilot | 2 × 0.5 vCPU | 1 |
| Launch | 4 × 1 vCPU | 2 |
| Year one | 12 × 1 vCPU (auto-scaled) | 6 |

Scale on **p95 latency and queue depth, not CPU.** A Node process waiting on Postgres shows low
CPU while serving nobody. Auto-scaling on CPU in an I/O-bound service scales down exactly when
it should scale up.

`location` scales independently and will be the majority of the fleet by year one — roughly
half the API tasks. This is the payoff for splitting it out.

## 8.7 Mobile and network

Nairobi is not a fast-network city, and this constrains the client more than the servers.

- Photos resize to 1280 px before upload; a 1.5 MB evidence image is p95 12 s on 3G, and a
  4 MB one is a failed errand.
- The offline queue is the default path, not an error path. Every write the runner makes is
  queued and retried; the UI shows pending, never failed.
- Location batches up to 4 fixes per request, which cuts request count by 4× and matters more
  for battery than for our servers.
- WebSocket reconnects with jittered backoff and falls back to a 5-second poll on the active
  errand only. A thundering reconnect after a cell tower blip is a self-inflicted outage.
- Payloads are gzipped and the feed is cursor-paginated at 20 — not because of server cost, but
  because a 200-item feed on a 3G connection is a blank screen.

## 8.8 Cost sketch

Monthly, AWS `af-south-1`, order of magnitude only.

| Item | Pilot | Launch | Year one |
| --- | --- | --- | --- |
| RDS | $60 | $320 | $1,400 |
| ElastiCache | $25 | $60 | $220 |
| ECS Fargate | $50 | $200 | $900 |
| R2 storage + egress | $10 | $60 | $500 |
| SMS (Africa's Talking) | $30 | $300 | $4,000 |
| Issuer per-card fees | varies | varies | varies |
| **Total (excl. issuer, SMS at launch scale)** | **~$175** | **~$940** | **~$7,000** |

Two observations. **SMS becomes the largest line item**, which is an argument for pushing
notification delivery to push-with-SMS-fallback aggressively rather than treating SMS as the
default. And **issuer per-card fees are the real unknown** — at one card per errand, 20,000
errands/day is 600,000 cards a month, and a fee of even $0.05 per card is $30,000. Negotiate
per-card pricing before the model is locked; if it cannot be made to work, the fallback is a
pooled card per runner per day with per-errand authorisation controls, which is a materially
different design and should be evaluated now rather than at 20,000 errands a day.

## 8.9 What breaks first

In the order we expect to hit them:

1. **Postgres connections**, well before CPU. Fixed by PgBouncer — do it at launch, not when it
   breaks.
2. **`runner_location_history` growth.** Fixed by partitioning and downsampling. Do the
   downsampling first; it is the cheapest 40% you will ever save.
3. **Issuer rate limits.** Unknown until we have the contract. Ask for the number, then set the
   `card.load` queue concurrency below it and let the queue absorb bursts.
4. **SMS cost**, not SMS throughput.
5. **The ops console**, socially rather than technically — one Legal Operations officer cannot
   adjudicate a dispute rate proportional to 20,000 errands a day. Model the staffing alongside
   the infrastructure.
