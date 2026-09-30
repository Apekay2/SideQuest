# 2. File structure

pnpm workspaces, Turborepo for task orchestration. Four apps, six shared packages.

```
sidequest/
├── apps/
│   ├── api/                        Fastify HTTP server
│   │   ├── src/
│   │   │   ├── server.ts           build(), plugin registration, graceful shutdown
│   │   │   ├── index.ts            entrypoint, listens
│   │   │   ├── plugins/
│   │   │   │   ├── auth.ts         JWT verify, req.actor, entitlement guard
│   │   │   │   ├── db.ts           Drizzle pool, req.tx helper
│   │   │   │   ├── idempotency.ts  Idempotency-Key header handling
│   │   │   │   ├── ratelimit.ts    Redis token bucket
│   │   │   │   ├── errors.ts       AppError → RFC 7807 problem+json
│   │   │   │   └── telemetry.ts    OTel spans, request-id propagation
│   │   │   └── routes/
│   │   │       ├── auth.routes.ts
│   │   │       ├── errands.routes.ts
│   │   │       ├── bids.routes.ts
│   │   │       ├── stalls.routes.ts
│   │   │       ├── evidence.routes.ts
│   │   │       ├── wallet.routes.ts
│   │   │       ├── payouts.routes.ts
│   │   │       ├── disputes.routes.ts
│   │   │       ├── ops.routes.ts        console-only, requires staff entitlement
│   │   │       └── webhooks.routes.ts   daraja + issuer, signature-verified
│   │   └── test/                   supertest integration specs per route file
│   │
│   ├── worker/                     BullMQ consumers, no HTTP surface
│   │   └── src/
│   │       ├── index.ts            worker registry, concurrency per queue
│   │       ├── outbox-poller.ts    outbox_event → BullMQ, 250 ms tick
│   │       └── jobs/
│   │           ├── auction-close.job.ts
│   │           ├── card-issue.job.ts
│   │           ├── card-load.job.ts
│   │           ├── card-void.job.ts
│   │           ├── settle-errand.job.ts
│   │           ├── payout-runner.job.ts
│   │           ├── timer-check.job.ts        on-time bonus, expiry
│   │           ├── card-sweeper.job.ts       nightly, voids orphans
│   │           └── notify.job.ts
│   │
│   ├── mobile/                     Expo, requester + runner in one binary
│   │   └── src/
│   │       ├── App.tsx
│   │       ├── navigation/         RootNavigator, RequesterTabs, RunnerTabs
│   │       ├── screens/            one folder per screen, see 05-ui-architecture.md
│   │       ├── components/         Button, Tag, Card, Sheet, PhotoCapture, QrScanner
│   │       ├── features/           react-query hooks + mutations per domain
│   │       ├── i18n/               en.json, sw.json, useT()
│   │       ├── theme/              tokens.ts — the only place colours exist
│   │       └── lib/                api client, offline queue, secure store
│   │
│   └── console/                    Next.js 14, internal, VPN + SSO only
│       └── src/app/
│           ├── (auth)/login/
│           ├── kyc/                queue, case detail
│           ├── disputes/           queue, evidence pack, ruling form
│           ├── errands/[id]/       full money trace for one errand
│           └── rulings/            immutable log
│
├── packages/
│   ├── domain/                     THE CORE — no I/O, no framework imports
│   │   └── src/
│   │       ├── errand/             machine.ts, spend-cap.ts, types.ts
│   │       ├── auction/            close.ts, ranking.ts
│   │       ├── card/               tranche.ts, decline-ladder.ts, issuer.port.ts
│   │       ├── ledger/             posting.ts, accounts.ts
│   │       ├── escrow/             freeze.ts, split.ts
│   │       ├── kyc/                tiers.ts, entitlements.ts
│   │       └── money/              Money value object — integer cents, never float
│   │
│   ├── db/                         Drizzle schema + migrations
│   │   ├── src/schema/*.ts         one file per table group
│   │   ├── src/repositories/*.ts   query functions, all take a tx
│   │   ├── migrations/*.sql        numbered, forward-only
│   │   └── seed/
│   │
│   ├── adapters/                   everything that talks to the outside world
│   │   └── src/
│   │       ├── issuer/             union-issuer.ts, mock-issuer.ts (implements IssuerPort)
│   │       ├── daraja/             stk.ts, b2c.ts, c2b.ts, signature.ts
│   │       ├── sms/                africas-talking.ts
│   │       ├── storage/            r2.ts, presign.ts
│   │       └── push/               expo-push.ts
│   │
│   ├── contracts/                  Zod schemas shared by API and clients
│   │   └── src/                    errand.contract.ts, bid.contract.ts, …
│   │                               plus generated openapi.json
│   │
│   ├── config/                     env.ts — the only reader of process.env
│   └── observability/              logger.ts, tracer.ts, metrics.ts
│
├── infra/
│   ├── terraform/                  vpc, rds, elasticache, ecs, r2, secrets
│   └── docker/                     Dockerfile.api, Dockerfile.worker, compose.yml
│
├── turbo.json
├── pnpm-workspace.yaml
└── .github/workflows/ci.yml        typecheck → lint → unit → integration → migrate-check
```

## Rules that keep this from rotting

**`packages/domain` imports nothing.** No Drizzle, no Fastify, no `node:fs`. It takes plain
data and returns plain data or throws a typed error. This is why the money rules are testable
in milliseconds and why an issuer swap is a one-file change.

**Repositories take a transaction, never open one.** Signature is always
`fn(tx: Tx, args): Promise<T>`. The route or job owns the transaction boundary, so a single
approval can hold escrow, write the tranche, and enqueue the job atomically.

**Adapters implement ports declared in `domain`.** `IssuerPort` lives in
`domain/card/issuer.port.ts`; `adapters/issuer/*` implements it. Tests inject `MockIssuer`,
which can be told to decline.

**One file per table group in `db/src/schema`.** Migrations are plain SQL, forward-only,
numbered. Never edit a shipped migration; add another.

**`contracts` is the API's only truth.** Routes validate with it, the mobile client and console
import the inferred types from it, and `openapi.json` is generated from it in CI. A response
shape cannot drift from what the client expects because both read the same Zod object.
