# Side Qwest

Errands in Nairobi, paid through escrow: a requester posts a Qwest, a runner does it stall by
stall, and every shilling moves through a double-entry ledger. This repo is the MVP built from
the Claude Design handoff (the original handoff README is kept as [HANDOFF.md](HANDOFF.md); the
design docs live in `project/handoff_sidequest_mvp/`).

| Part | Where | What it is |
|---|---|---|
| Mobile app | `apps/mobile` | Expo SDK 57 / expo-router, requester and runner, EN + SW. Built to the **Cross-Platform Parity** design. |
| API | `apps/api` | Fastify 5. Every request runs inside `withActor()`, so Postgres RLS decides what it can see. |
| Worker | `apps/worker` | Outbox poller → BullMQ: card loads and the decline ladder, settlement, payouts, notifications, reconciliation. |
| Ops console | `apps/console` | Next.js 16. KYC review, disputes and rulings, money trace. Built to the **Ops Console** design. |
| Packages | `packages/*` | `domain` (ledger, state machine, pure rules), `db` (migrations, gates), `config`, `contracts`, `adapters`, `observability`. |
| End-to-end | `tests/e2e` | The API and worker run in-process against real Postgres and Redis, as the RLS roles. |

## Run it

You need Node 22, pnpm 10, Postgres 16 with PostGIS and h3 (`postgresql-16-postgis-3`,
`postgresql-16-h3`), and Redis 7.

```sh
pnpm install
node scripts/dev-env.mjs          # writes .env: fresh secrets, development drivers
pnpm migrate:up                   # as the owner (MIGRATE_DATABASE_URL in .env)
pnpm dev:api                      # :3000
pnpm dev:worker
pnpm dev:console                  # :3001
pnpm dev:mobile                   # Expo; press w for web
```

Development drivers stand in for the outside world: a fake Daraja that sends real callback
bodies through the outbox, a Redis-backed mock card issuer, console SMS (OTPs appear in the API
log), and local storage with signed URLs. Production config refuses all four.

**Something to look at.** With the API writing its log to a file:

```sh
pnpm dev:api > /tmp/api.log 2>&1 &
pnpm seed:demo /tmp/api.log   # the parity design's state: Kangemi run, stall 2 waiting on approval
pnpm seed:ops  /tmp/api.log   # a staff officer (0711000009), a tier-3 KYC case, a dispute
```

Sign in to the app as `0711000001` (requester) or `0711000002` (runner), and to the console as
`0711000009`. The seeds go through the real API; the only SQL they run is the promotion an
administrator would do by hand. Seeded photos are plain colour blocks.

**Docker.** `docker compose up --build` runs Postgres (with h3), Redis, a one-off migration
job, the API, the worker and the console from this repo's images. It reads the same `.env`.

## Check it

```sh
pnpm typecheck        # every package, mobile included
pnpm test             # unit + mobile (iOS and Android presets) + e2e: 207 tests
pnpm lint:parity      # Platform branching only in src/platform; en/sw keys and {placeholders} match
DATABASE_URL=<owner url> pnpm db:gates   # RLS coverage, currency invariants, append-only ledger
```

CI (`.github/workflows/ci.yml`) runs all of that. It also builds the Postgres+h3 image,
migrates twice (the second run must be a no-op), and runs the e2e suite against it. On top of
that: a secret scan, a dependency and image scan, a gate against unscoped database access in
route code, and a marker required for destructive DDL.

## The parity rule

*Brand is shared, chrome is native.* Every difference between iOS and Android lives in
`apps/mobile/src/platform/adaptive.ts`, and `lint:parity` fails the build on a `Platform` check
anywhere else. `src/parity.test.tsx` states the design's three sections as tests, run under both
jest-expo presets:

1. **Requester shell.** iOS has five tabs including Post. Android has four tabs with an M3 pill
   and promotes Post to a FAB.
2. **Stall approval sheet.** Held identical on both. The test fails if the layout order changes
   (name, stall count, photo, items, total, cap, approve, substitute, decline). Only the button
   height and the drag handle adapt.
3. **Decline confirm.** An iOS action sheet against an M3 dialog with the confirm action last.
   On both: the scrim does not dismiss, and nothing destructive has default focus.

Defaults taken for the open items in 11-cross-platform §11.8: phone portrait only, minimum
Android 9 / iOS 15, light mode only. Performance targets are noted, not measured.

## Where this departs from the handoff

The handoff's code had never run. Getting it to run turned up defects that were fixed where
they were found. Each fix has a test or a gate, so a regression goes red.

**Schema and RLS**
- Migrations 0001–0005 did not apply: a missing `CASCADE`, an enum used in the same transaction
  that added it, and a view column and an enum literal that didn't exist. They were fixed in
  place, since they had never been applied anywhere. Everything after that is additive
  (0006, 0007).
- SECURITY DEFINER helpers were owned by the superuser. Under FORCE RLS they failed as any real
  role, so they now belong to a NOLOGIN definer role.
- The posting and posting-group policies recursed into each other. Fixed with a definer helper.
- The worker could UPDATE `posting` (caught by the RLS gate) and `posting_group` (caught by the
  new ledger gate, fixed in 0007). The ledger is now append-only for every login role.
- A blanket revoke left reference tables and `spatial_ref_sys` unreadable. Several endpoints had
  no policy or grant to do their job: sign-in, refresh, KYC submit, bid award, escrow creation.

**API and worker**
- `/runners/nearby` could never have run. It read nonexistent columns and used `ANY()` over a
  set-returning h3 function. Its H3 disk was also too small for its radius: k=1 reaches about
  1.4 km, not 3 km.
- `reconcile.job.ts` queried seven columns and a method that don't exist, so it would have paged
  every night. It was rewritten against the real schema.
- Bugs found by running the stack:
  - OTP consume ran outside its RLS scope.
  - The API used Redis before it was ready.
  - Expiry timers trusted their schedule instead of checking the clock.
  - Card `loaded_cents` counted till payments.
  - BullMQ job IDs came from a bigserial, so after a database rebuild new jobs were silently
    dropped as duplicates.
- The dispute queue filtered on `open`, but the worker moves every dispute to `evidence` when it
  freezes escrow. The default queue is now both.
- Drizzle was dropped. The SQL migrations are the schema, and a mirror would drift.

**CI and build**
- The handoff pipeline called scripts, lint rules and paths that were never written. It ran on
  `postgis/postgis`, which has no h3, so the migrations could not have applied. It was rebuilt
  around what exists.
- The tsup build scripts used a CLI flag that doesn't exist. Once fixed, the bundles inlined
  CommonJS dependencies and crashed on boot. Both are fixed, and the images were booted to
  check.

**Design**
- **KYC queue:** the design's "Flag" column needs vendor flags that don't exist in the data
  model. The column shows the applicant's role and current tier instead. "Ask again" asks for
  the reason the applicant will read, because the API requires one.
- **Ruling form:** the design shows four outcome buttons. Per 05 §5.6, choosing one also shows
  editable amounts, live split arithmetic against the frozen escrow, and a rationale of at least
  40 characters.
- **Money trace:** added per 05 §5.6, as the page that answers "where is the money". The rulings
  log gains a Split column.

## Known limits

- **Native builds.** No iOS or Android build was produced; the Expo build servers weren't
  reachable from where this was built. The app is verified through jest under both platform
  presets, and a web export driven against the live API. Native dependency versions are pinned
  from Expo's bundled map.
- **Real providers.** The Daraja, card issuer, Africa's Talking and R2 drivers are written but
  haven't been exercised against their sandboxes.
- **Console behind one IP.** All officer traffic reaches the API from the console server's
  address, so the per-IP OTP (20/h) and refresh (30/h) limits are shared across officers. Raise
  them for that address, or forward the client IP through a trusted proxy hop.
- **More than one console instance.** Refresh rotation is single-flighted per process. With
  several instances, pin officers with sticky sessions or move that state to Redis.
- **Postgres image.** `infra/postgres` was not built locally, because the sandbox blocked apt.
  CI builds it on every run. The API, worker and console images were built and booted.
