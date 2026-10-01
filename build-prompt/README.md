# Building Side Qwest with another model, and comparing

This folder holds everything needed to have another AI model build Side Qwest from scratch, and
to score its build against this repository's build on the same terms.

| File | What it is |
|---|---|
| `PROMPT.md` | The full build prompt. Give it to the other model as is, along with `acceptance.mjs`. |
| `acceptance.mjs` | A black-box test suite (Node 22, no dependencies). It talks to any running build over HTTP and scores it out of 27. |

The prompt was written from the code that was built here, not from the original design
handoff in `project/`. It describes behaviour and contracts, not visual design. If you want the
other model to match the visual design too, give it the design files from `project/` yourself.

## 1. Give the other model the prompt

Paste `PROMPT.md` as the task and attach `acceptance.mjs`. Tell it the build is done only when
`node acceptance.mjs` passes 27/27 and `pnpm verify` is green.

## 2. Run the acceptance suite against a build

You need Postgres 16 with PostGIS and h3, and Redis 7. For each build:

```sh
pnpm install
node scripts/dev-env.mjs          # or the build's own equivalent
pnpm migrate:up
redis-cli FLUSHALL                # sign-in rate limits are tested; start each run clean
pnpm dev:api > /tmp/api.log 2>&1 &
pnpm dev:worker > /tmp/worker.log 2>&1 &
node build-prompt/acceptance.mjs --api http://localhost:3000 --otp-log /tmp/api.log
node build-prompt/acceptance.mjs --api http://localhost:3000 --otp-log /tmp/api.log --json > score.json
```

Notes:
- The suite reads sign-in codes from the API's log, so it needs the console SMS driver and the
  API's stdout in that file.
- Top-ups only credit through the worker, so the worker must be running.
- Run one build at a time on port 3000, or pass another `--api` URL.
- Flush Redis between runs: the suite uses about 13 sign-in codes per run, and the per-IP limit
  is 20 an hour.

**This repository's build scores 27/27.**

## 3. Compare beyond the automated score

The suite covers the HTTP contract. Score the rest by reading and running each build:

| Area | Weight | What to check |
|---|---|---|
| Acceptance suite | 25 | Checks passed, out of 27 |
| Money correctness | 15 | Is the ledger double-entry and append-only? Is there no balance column? Does the full market run settle with exact balances? Are tranche keys deterministic? Does the decline ladder follow §4.5? |
| Data isolation | 10 | Is RLS forced on every table, with no role able to bypass it? Is there no SQL outside the per-request scoped transaction? Is msisdn hidden by column grants? |
| Business rules | 10 | Do state machine, fee split, tiers and entitlements match Appendices B and C, with unit tests? |
| Security | 10 | Refresh token reuse, OTP limits, idempotency, webhook token, CORS, CSP, log redaction |
| Mobile app | 10 | Runs on iOS and Android presets; the parity rule and its lint; English and Swahili; the approval sheet order; accessibility |
| Ops console | 5 | All pages; the ruling form arithmetic; tokens server-side only |
| Legal | 5 | Consent, re-consent, export, erasure, location consent, retention |
| Tests | 5 | Domain, end-to-end against real Postgres and Redis, mobile under both presets |
| Operability | 5 | `pnpm verify`, idempotent migrations, docker compose, a README that tells the truth about gaps |

For a quick objective signal on both builds, also record:

```sh
pnpm verify; echo $?                     # green or not
pnpm test 2>&1 | grep -E "Tests"         # how many tests, and passing
DATABASE_URL=<owner url> pnpm db:gates   # RLS coverage, ledger balance, append-only (if the build has them)
```
