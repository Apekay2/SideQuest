# Side Qwest — MVP engineering handoff

Errand marketplace for Kenya. Requesters post errands (market runs, queue standing, document
drops); runners bid blind; spend authority is a **one-time virtual card issued per errand**,
loaded in tranches as the requester approves each stall.

## What is in this bundle

| Path | What it is |
| --- | --- |
| `01-architecture.md` | System architecture, service boundaries, deployment topology |
| `02-file-structure.md` | Monorepo layout, every package and its responsibility |
| `03-schema.sql` | Full PostgreSQL DDL — tables, enums, indexes, constraints |
| `04-api.md` | Every endpoint: method, path, auth, body, responses, errors |
| `05-ui-architecture.md` | Client app + ops console structure, navigation, state |
| `06-services.md` | Service split, events, failure isolation, the six subsystems |
| `07-security.md` | Threat model, money-path controls, location privacy, DPA 2019 |
| `08-scale.md` | Load arithmetic, database sizing, what breaks first, cost |
| `09-appsec-audit.md` | Application security audit: RLS, rate limiting, secrets, XSS/session. 12 findings, CI gates |
| `10-panel-review.md` | Panel review: current state, six corrected money-path defects, open risks, global-market readiness |
| `11-cross-platform.md` | iOS/Android parity: what is shared, what adapts, accessibility floor |
| `Cross-Platform Parity.dc.html` | The parity design — both platforms side by side, annotated |
| `03b-schema-v2.sql` | Migration 0002: assignment modes, funding modes, two-sided fees, checkpoints/ETA, payment rails |
| `03c-rls.sql` | Migration 0003: row-level security — four roles, forced RLS, per-transaction actor |
| `03d-outbox-hardening.sql` | Migration 0004: outbox lease, attempt count, parked state |
| `03e-currency.sql` | Migration 0005: currency + market dimensions, single-currency posting groups, FX table, client/platform fund class |
| `code/` | Production-ready TypeScript for the money core, API and workers |
| `code/ci/ci.yml` | Phase 0 CI pipeline: RLS gate, migration gate, secret scan, cross-tenant and concurrency suites |
| `code/scripts/assert-rls-coverage.ts` | The RLS coverage gate — forced RLS, policy presence, no `BYPASSRLS`, append-only ledger grants |
| `code/worker/jobs/reconcile.job.ts` | Nightly reconciliation with per-account meaning assertions (the checks P-1 needed) |
| `design/` | The HTML design prototypes from this project |

**The `design/` files are design references, not production code.** They are HTML prototypes
that show intended look and behaviour at high fidelity — exact colours, type, spacing and
interaction. Recreate them in the target environment (React Native for the app, Next.js for
the console) using the tokens listed in `05-ui-architecture.md`. Do not ship the HTML.

**The `code/` files are production code.** They are written to be dropped into the monorepo at
the paths named in each file's header comment. They compile under `strict: true`, have no
placeholder bodies, and encode the money rules that the rest of the system must not re-derive.

## Fidelity

High-fidelity. Colours, type and spacing in the prototypes are final. The 44px minimum tap
target and the EN/SW bilingual requirement are hard constraints, not suggestions.

## Stack

Chosen for a small team shipping in Nairobi, low-bandwidth clients, and money correctness.

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript 5.6, Node 20 LTS | One language across API, workers, web, mobile |
| API | Fastify 4 + Zod | Fast, schema-first, JSON Schema out of the box |
| Database | PostgreSQL 16 | Transactions are the product; needs `SERIALIZABLE` on ledger writes |
| ORM | Drizzle | Generates SQL you can read; migrations are plain SQL |
| Cache / queue | Redis 7 + BullMQ | Auction timers, retries, idempotency locks |
| Object store | S3-compatible (Cloudflare R2) | Evidence photos; egress cost matters |
| Mobile | React Native (Expo, dev client) | One codebase; OTA updates without store review |
| Console | Next.js 14 App Router | Internal only, server components, no SPA weight |
| Auth | Phone OTP → short-lived JWT + rotating refresh | Nobody in this market has an email-first identity |
| Payments in | Safaricom Daraja (STK push, C2B) | Escrow funding |
| Payments out | Daraja B2C | Runner payouts, refunds |
| Card issuing | Issuer adapter, `Issuer` interface | Provider swaps without touching domain code |
| Messaging | Africa's Talking (SMS/USSD fallback) | Push cannot be assumed |
| Observability | OpenTelemetry → Grafana Cloud | Traces across the money path |
| Deploy | Docker → AWS ECS Fargate, af-south-1 | Data residency under the Kenya DPA 2019 |

## Non-negotiable invariants

These are asserted in code and in database constraints. Every one of them has bitten a
marketplace before.

1. **A runner never spends their own money.** Every outbound spend is authorised on the
   errand's card or paid from the errand's own M-Pesa balance.
2. **The ledger only ever balances.** Every money movement is a double-entry pair; a partial
   write is impossible because both legs are in one transaction with a deferred sum check.
3. **Every external call is idempotent.** Issuer and Daraja calls carry a key derived from
   `(errand_id, tranche_seq, attempt)`. A retry can never double-spend.
4. **A card outlives nothing.** It is voided when the errand reaches a terminal state, by the
   settlement worker and again by a nightly sweeper.
5. **PII lives in one table.** `kyc_case` holds identity documents; every other service reads
   a derived `verification_tier` integer. Deleting a `kyc_case` cannot orphan a foreign key.
6. **Escrow can only be split by Legal Operations.** No automated path reverses a frozen
   balance.

## Getting started

```bash
pnpm install
docker compose up -d          # postgres, redis, minio, jaeger
pnpm db:migrate
pnpm db:seed                  # two requesters, four runners, one open errand
pnpm dev                      # api :3000, console :3001, expo :8081
```

Environment variables are listed with types in `code/config/env.ts`. Nothing reads
`process.env` outside that file.

## Build order

**Read `06-services.md` §6.11 before planning the schedule.** The pilot window and five payment
rails do not both fit; the rails are the binding constraint, not the services.

Ship in this sequence. Each step is independently demoable and nothing later invalidates
something earlier.

1. Identity: OTP auth, tiers, entitlement claims.
2. Errand lifecycle without money: post, offer, accept, complete.
3. Location ingest, the 3 km query and the map.
4. Ledger and escrow funding via STK push and wallet.
5. Card issuance and loading — upfront first, tranches second. Budget the most time here.
6. Evidence capture, approval, the decline ladder.
7. Settlement, the two-sided fee, runner payout.
8. Progress checkpoints and the ETA engine, behind a flag.
9. Disputes, ops console, Legal Operations tooling.
10. Remaining rails, batching, direct invites, relationship matching.
