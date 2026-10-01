# Build Side Qwest: errands with escrowed payments, for Nairobi

You are a senior full-stack engineer. Build the complete, runnable system described below:
- a mobile app for iOS and Android
- an HTTP API
- a background worker
- an operations console
- the database schema
- the tests

Write real code that runs. No pseudo-code, no stubs that return canned data, no
"left as an exercise". When something depends on a third party (M-Pesa, the card issuer, SMS,
storage, push), write the production adapter and a development driver that behaves like the
real thing, so the whole system runs on a laptop.

Your build is scored by an automated black-box suite (`acceptance.mjs`, §14) that talks to your
API over HTTP. Match the HTTP contract in §8 and Appendix A exactly: paths, methods, status
codes, field names and error codes.

---

## 1. The product

Side Qwest lets someone in Nairobi (the **requester**) post an errand and have a vetted
**runner** do it. The main errand is a market run: buy these items at these stalls, in this
order, and deliver them. Other kinds are queue standing, document drop-off, and custom jobs.

Money never passes hand to hand:
1. The requester tops up a wallet with M-Pesa.
2. Funding an errand moves the whole deposit into escrow.
3. At each stall, the runner photographs the goods and the prices.
4. The requester approves that stall in the app.
5. Only then is exactly that amount loaded onto a single-use virtual card for the errand, or
   paid to the stall's M-Pesa till.
6. At delivery, the requester shows a rotating QR code and the runner scans it. That settles
   the errand: the runner's fee goes to their earnings, and the unspent goods money returns to
   the requester's wallet.

**Actors**
- **Requester:** posts and funds errands, approves or declines stalls, receives the goods.
- **Runner:** bids on or accepts errands, shops, delivers, cashes out earnings to M-Pesa.
  Higher verification tiers unlock more.
- **Staff (operations):**
  - reviews identity verification (KYC)
  - handles SOS alerts
  - rules on disputes, and is the only one who can split a frozen escrow
  - manages accounts and staff access
  - watches the money

**Market:** Kenya. Currency KES, stored as integer cents. Phone numbers are Kenyan mobile
numbers, normalised to E.164 (`0712345678` → `+254712345678`). Languages are English and
Swahili throughout the app.

---

## 2. Required stack

Use exactly this stack so builds can be compared like for like:

| Part | Technology |
|---|---|
| Monorepo | pnpm workspaces, Node 22, TypeScript (strict) |
| Database | PostgreSQL 16 with PostGIS and the `h3` extension; plain SQL migrations (no ORM schema) |
| Cache, queues, rate limits | Redis 7; BullMQ for jobs |
| API | Fastify 5, `postgres` (postgres.js), Zod for request validation |
| Worker | Node process: an outbox poller feeding BullMQ |
| Mobile | Expo (latest SDK) with expo-router, TanStack Query, Zustand for session state only |
| Ops console | Next.js (App Router), server components and server actions; the browser never holds an API token |
| Shared code | `packages/contracts` (Zod schemas and response types, imported by API, app and console), `packages/domain` (pure business rules, no I/O), `packages/db`, `packages/adapters`, `packages/config`, `packages/observability` |
| Tests | Vitest for packages, API and end-to-end; jest-expo for the app (run under both iOS and Android presets) |

**Required scripts in the root `package.json`:**
- `dev:api`, `dev:worker`, `dev:console`, `dev:mobile`
- `migrate:up`
- `test`, `typecheck`
- `verify` (typecheck, tests and build)

Also provide `scripts/dev-env.mjs`, which writes a working `.env` for development with fresh
random secrets, and a `docker-compose.yml` that runs the whole backend.

---

## 3. Development drivers (must exist; production config must refuse them)

| Port | Dev driver | Behaviour |
|---|---|---|
| SMS | `console` | Prints every SMS to the API's stdout, one line per message, with the full text. The sign-in text is `Your Side Qwest code is NNNNNN. It expires in 5 minutes. Never share it.` **The acceptance suite reads codes from this log.** |
| M-Pesa (Daraja) | `fake` | STK push and B2C succeed after a short delay. They deliver the same callback bodies Daraja would, through the same parsing path as the real webhook. Do not credit the wallet directly. |
| Card issuer | `mock` | Redis-backed virtual cards: load, spend, void and balance. |
| Storage | `local` | Files on disk, with HMAC-signed, expiring PUT/GET URLs served by the API at `/uploads/...`. |
| Push | `console` | Logs. The production driver is Expo push. |

Config is validated at boot with Zod. With `NODE_ENV=production`, boot must refuse:
- any development driver
- placeholder values such as `CHANGEME`
- secrets shorter than 32 characters, or the same secret reused for two purposes

---

## 4. Business rules

These live in `packages/domain` as pure functions, with unit tests.

### 4.1 Verification tiers and entitlements

| Tier | How it is reached | Entitlements |
|---|---|---|
| 0 | — | `errand.browse` |
| 1 | phone number verified by OTP (every new account starts here) | + `errand.post`, `wallet.topup` |
| 2 | ID front, ID back and a selfie, approved by staff | + `bid.place`, `payout.request` |
| 3 | tier 2, plus a certificate of good conduct, next of kin and movement (location) consent | + `errand.accept`, `batch.create` |

- **Staff entitlements** are granted individually, never derived from a tier: `ops.read`,
  `kyc.review`, `evidence.view`, `ledger.read`, `location.read_cells`, `audit.read`,
  `legal_ops`, `accounts.manage`, `staff.admin`.
- **Entitlements travel in the access token.** The API rejects an unentitled request before
  touching the database, and the database enforces the same rules again through RLS (§6).

### 4.2 Errand state machine

Every transition is in one table. A transition that isn't in the table throws
`ERRAND_STATE_INVALID` (HTTP 409). The table is Appendix B: copy it exactly.

- **Statuses:** `draft`, `awaiting_funds`, `open`, `offered`, `awarded`, `en_route`, `shopping`,
  `awaiting_approval`, `handover`, `settled`, `cancelled`, `disputed`, `expired`.
- **Terminal:** `settled`, `cancelled`, `expired`.
- **Live** (a runner is assigned): `awarded`, `en_route`, `shopping`, `awaiting_approval`,
  `handover`.

**Assignment modes:**
- `pick`: the requester offers the errand to one runner, and the offer lapses after 90 seconds.
- `open`: the first eligible runner to accept gets it.
- **Sealed auction:** runners bid a fee and an ETA. Bids are invisible until the auction closes
  (5–60 minutes), then the requester awards one.

### 4.3 Fees

The platform takes **12% of the runner's fee, never of the goods**. The take is split in two:
- the **requester's half** is charged on top of the fee at deposit
- the **runner's half** is deducted at payout of the fee
- if the take is an odd number of cents, the extra cent goes to the requester's half, so the
  runner never loses a cent to rounding

Round the total with banker's rounding (round half to even).

```
take         = roundHalfEven(fee × 1200 / 10000)
runner_half  = trunc(take / 2)
requester_half = take − runner_half
deposit      = max_fee + spend_cap + bonus + requester_half(max_fee)
```

Test vector: max fee 40 000, cap 100 000, bonus 0 → take 4 800, requester half 2 400, deposit **142 400**.

Store the agreed fee split once, at assignment. Never recompute it for display: the rate can
change, and history must not.

### 4.4 Double-entry ledger

Every money movement is a posting group whose postings sum to zero (debit positive, credit
negative). Enforce this:
- in the domain code
- in the database, with a deferred constraint trigger
- by making `posting` and `posting_group` append-only for every login role (no UPDATE or
  DELETE grants)

Never store a balance column: balances are sums over postings.

**Accounts:** `user_wallet`, `escrow_hold`, `errand_card_float`, `platform_fee`,
`runner_earnings`, `vendor_paid`, `reimbursement_due`, `mpesa_settlement` (the boundary with
the outside world, so it goes negative as money enters), `service_fee_requester` and
`maintenance_fee_runner`.
- The last two, plus `platform_fee`, are **platform money**.
- Every other account is **client money**, and every posting records which class it belongs to.

Every group has a currency (KES) and never mixes currencies. Summed over the whole ledger,
each currency is zero at all times.

**Flows that must exist:**

| Flow | Postings |
|---|---|
| Top-up | settlement → wallet. Only on the M-Pesa callback, never on the client's word. |
| Fund escrow | wallet → escrow, the whole deposit |
| Assignment | requester half → `service_fee_requester` (recognised at this point) |
| Stall approved | escrow → card float, for the approved total |
| Spend captured | float → `vendor_paid` |
| Load failed | float → escrow (reversal) |
| Card voided with value left | float → escrow, for the amount the issuer reports |
| Runner paid cash (ladder rung 3) | float → `reimbursement_due` |
| Settlement | escrow pays the agreed fee minus the runner half into `runner_earnings`, plus any earned bonus; `reimbursement_due` clears into earnings exactly once; the remainder returns to the wallet |
| Cancel before assignment | escrow → wallet, all of it |
| Cancel after assignment | the runner gets the cancellation fee; the requester's fee half stays; the rest returns |
| Dispute ruling | split the frozen escrow between the two parties; only `legal_ops` can do this |
| Payout and reversal; withdraw | as named |

### 4.5 Paying at a stall (the decline ladder)

When a stall is approved, a tranche for exactly its total is created. The worker then tries
three rungs in order:
1. **Load the errand's card.** Retry exactly once, and only if the decline code is retryable.
2. **Pay the stall's M-Pesa till** from the errand's held balance. Skip this rung if the stall
   has no till number.
3. **Reimbursement.** The runner pays cash, and the requester confirms within 5 minutes that
   they owe it.

If the confirmation window expires, or no rung is left, escalate to staff.

Tranche idempotency keys are deterministic, `tr:{errand}:{seq}:{attempt}`, so a retried job
can never load a card twice. A stall total above the remaining spend cap fails with
`SPEND_CAP_EXCEEDED`.

### 4.6 Stall evidence and approval

- **Evidence photos.** The runner photographs goods and receipt through signed uploads, and
  sets the price of each line item.
  - The requester can reject a photo. One retake is allowed, and a second rejection fails with
    `RETAKE_EXHAUSTED`.
  - Substitutions record what they replace.
- **Approve and decline.** The requester approves (which funds the tranche) or declines with a
  reason. Approvals are rate limited per errand.

### 4.7 Handover

The requester's app shows a QR token that rotates every 60 seconds. It is derived from a
server secret, the errand and the time step; the step either side of the current one is also
accepted. The runner scans it, and the scan is single use: a conditional update out of
`handover`. That settles the errand.

### 4.8 Live location

Runners share location only during their own live errand, and only with movement consent.
- **End-to-end authentication.** The two phones run an X25519 key exchange and both confirm a
  hash of the two public keys and the errand id. Each location fix carries an HMAC that only
  the requester's phone can verify; the server stores and relays fixes but cannot forge one.
- **Rejected fixes.** Fixes are dropped if they are out of sequence or replayed. A
  stale or revoked link reads as such.
- **Retention.** Precise points are kept 30 days. A coarse H3 cell (resolution 9) stays for
  demand analysis.
- **Finding runners.** `/runners/nearby` uses an H3 k-ring sized to the radius, and reports
  distance as a band, never an exact position.

### 4.9 Safety and disputes

- **SOS** is available on any live errand.
  - It snapshots the location and both identities, and alerts staff.
  - Its rate limit never blocks a genuine alert: the limiter allows the request even when
    Redis is down.
- **Disputes.** Either party can open one, with reasons `goods_wrong`, `goods_missing`,
  `overcharged`, `no_show`, `safety` or `other`. Opening a dispute freezes the escrow.
- **Rulings.** Staff with `legal_ops` rule `requester_favour`, `runner_favour`, `split` or
  `void`.
  - The amounts must add up to the frozen escrow.
  - The rationale must be at least 40 characters.
  - Rulings are append-only.

---

## 5. Auth and sessions

- **One-time codes.** Sign-in is by OTP over SMS: 6 digits, 5-minute expiry, at most 3 verify
  attempts per challenge. Store only an HMAC of the code, and compare in constant time.
- **New accounts.** `POST /auth/verify` creates the account if the number is new, with the
  given `role` (`requester` or `runner`) and `display_name`, at tier 1.
- **Access token.** HS256 JWT, at most 15 minutes. Claims: `sub`, `role`, `tier`, `ent`
  (entitlements), `sid` (session id) and `lg` (legal acceptance is current).
- **Refresh token.** Opaque, 30 days, stored hashed, bound to the device id if one is sent. It
  rotates on every use.
  - Reusing a spent refresh token revokes the whole token family, including the newest token.
  - `POST /auth/logout` revokes the session.
- **Re-checking sessions.** Money routes and the WebSocket re-check the session row, so a
  revoked session stops at once. The WebSocket closes at token expiry and re-checks the
  session every minute.
- **Suspended accounts** cannot sign in (`ACCOUNT_SUSPENDED`).
- **Console sign-in** sends `staff_only: true`, which never creates an account and issues a
  session only to staff.
- **Store-review login (optional).** If `REVIEW_LOGIN_MSISDN` and `REVIEW_LOGIN_CODE` are
  set, that one number signs in with that fixed code and receives no SMS. It can never be
  staff.

---

## 6. Database and data access

- **Plain SQL migrations**, numbered, forward-only. Rerunning them is a no-op.
- **Roles:**
  - the owner, used only by the migrator
  - `sidequest_app`, the API
  - `sidequest_worker`
  - `sidequest_ops`, the API's `/ops` routes
  - a `NOLOGIN` definer role that owns every `SECURITY DEFINER` function
- **Row-level security.** Every table has RLS enabled **and forced**, and at least one policy;
  no application role can bypass RLS.
  - Each request runs in a transaction that sets `app.actor_id` and `app.entitlements` as
    transaction-local settings.
  - Policies read them through helpers such as `app_actor()`, `app_has_ent(text)` and
    `app_is_party(errand)`.
  - Route code never runs SQL outside this scoped transaction.
- **Column grants.** Customers never read another person's phone number. Use column grants:
  the app role has no SELECT on `account.msisdn`.
- **Transactional outbox.** A request that needs background work inserts an `outbox_event` in
  the same transaction. The worker claims rows with `FOR UPDATE SKIP LOCKED` and enqueues
  BullMQ jobs with the job id `outbox-<event_id>`. Jobs are idempotent. After N failures a
  row is parked, never dropped.
- **Idempotency keys** for POSTs that create resources or move money. Stored per actor, the
  response is replayed for 24 hours:
  - a missing key gets 400 `IDEMPOTENCY_KEY_REQUIRED`
  - the same key with a different body gets 409 `IDEMPOTENCY_CONFLICT`
  - a retry while the original is still in flight gets 409 `IDEMPOTENCY_IN_FLIGHT`
- **Gate scripts**, runnable in CI:
  - RLS coverage
  - the ledger balances per currency
  - posting tables are append-only for every login role

---

## 7. API conventions

- Money is integer minor units, in fields named `*_cents`. Timestamps are ISO 8601 UTC
  strings. Ids are UUIDs.
- **Errors are RFC 7807**, with `Content-Type: application/problem+json` and a body of
  `{ type, title, status, code, details?, request_id }`. Clients branch on `code`, never on
  `title`. The codes are in Appendix A (`ERROR_CODES`), plus:
  - `UNAUTHENTICATED`, `SESSION_REVOKED`, `ACCOUNT_SUSPENDED`
  - `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_IN_FLIGHT`
  - `KYC_INCOMPLETE`, `LINK_MISMATCH`, `INTERNAL`
- **Not visible means 404.** A resource the caller can't see returns 404, not 403. Don't
  reveal that it exists.
- **Validation errors** are 400 `VALIDATION`.
- **Rate limits** are Redis sliding windows. Exceeding one returns 429 `RATE_LIMITED`. Some
  limits deny when Redis is down, others allow; SOS and location always allow.

| Limit | Allowance |
|---|---|
| OTP request | 5/h per number and 20/h per IP |
| OTP verify | 3 per 15 min per number |
| Refresh | 30/h per IP |
| Writes | 60/min per account |
| Reads | 300/min per account |
| Top-up | 10/h |
| Payout | 5/day |
| KYC submit | 5/day |
| Stall approve | 12/h per errand |
| SOS | 10/h, never blocking |

- **Security headers** on every response:
  - CSP `default-src 'none'`
  - HSTS
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: no-referrer`
  - `Cache-Control: no-store`
  - no `X-Powered-By`
- **CORS** is an exact-match allowlist; never reflect an arbitrary origin. Writes that carry a
  cookie also check `Origin` or `Referer` against the whole origin.
- **Body limits:** JSON 256 KB, signed upload PUTs 8 MB.
- **M-Pesa webhooks** live at `/webhooks/daraja/:token/...`. The secret path token is compared
  in constant time and redacted from logs. The source IP must also be in Safaricom's CIDR
  allowlist. With the fake driver, the webhook routes accept nothing.
- **Health checks:** `GET /health/live` returns 200, and `GET /health/ready` returns
  `{ "ok": true, "db": true, "redis": true }`.

---

## 8. Endpoints

Request bodies and response types are Appendix A: implement them exactly. "Id" means
`Idempotency-Key` required.

**Auth and account**
| Method | Path | Notes |
|---|---|---|
| POST | /auth/otp | `{msisdn}` → 201 `{challenge_id, expires_at}` |
| POST | /auth/verify | → 200 `Session`. Creates the account if new; requires `accept_legal` (§11) |
| POST | /auth/refresh | `{refresh}` → 200 `Session`; 401 if spent, revoked or expired |
| POST | /auth/logout | revokes the session |
| GET | /me | `Me` |
| PATCH | /me | `PatchMe` → `Me` plus `refresh_required` when the role changed |
| POST | /me/legal | accept the current legal versions → 204 |
| POST / DELETE | /me/push-token | register or unregister an Expo push token |
| GET | /me/export | everything held about the caller, as JSON (§11) |
| POST | /me/delete | `{confirm:"DELETE"}` → 204 (§11) |
| GET / POST | /me/location-consent | `LocationConsent` / `{consent}` → 204 |

**KYC**
- `POST /kyc/cases` with `{target_tier}`
- `GET /kyc/cases/mine`
- `GET /kyc/cases/:id`
- `POST /kyc/cases/:id/documents`, which returns a presigned upload for a slot
- `POST /kyc/cases/:id/submit`, which returns `KYC_INCOMPLETE` with `details.missing` if
  requirements are missing

**Errands:** `POST /errands` → 201 `ErrandDetail` plus `deposit_cents`, in status `draft`. Then:
- **Reading:**
  - `GET /errands?scope=live|history&as=requester|runner`
  - `GET /errands/:id`
- **Lifecycle:**
  - `POST /errands/:id/publish`
  - `POST /errands/:id/fund` `{rail:"wallet"|"mpesa_stk"}` → 200 when funded from the wallet,
    202 when an STK push is started; 409 `INSUFFICIENT_FUNDS` if the wallet is short
  - `POST /errands/:id/cancel` (Id)
- **Assignment:**
  - `offer`, `GET offers`, `decline-offer`, `invite`, `accept`
  - `bids`: `POST` (sealed), `GET` (sealed count until close), `DELETE /bids/mine`
  - `award`
- **The run:** `start`, `arrive`, `ready`, `handover-token` (GET), `handover` (POST
  `{qr_token}`)
- **Stalls:**
  - `GET /errands/:id/stalls`
  - `POST .../stalls/:sid/items` (prices), `evidence` (presign), `submit`, `approve`,
    `decline`, `substitute`, `retake`
- **Money on the errand:** `GET tranches`, `GET tranches/:tid`, `POST reimbursement/confirm`,
  `GET escrow`, `GET evidence`
- **Chat and safety:** `GET/POST messages`, `POST sos`
- **Location link:** `GET/POST/DELETE link`, `POST link/ack`, `GET location`,
  `POST location/requester`
- **Runner and batches:**
  - `GET /feed?lat&lng&radius_m`
  - `GET /runners/nearby?errand_id`
  - `POST /location` (batched HMAC fixes)
  - `POST /presence`
  - `GET /batches/eligible?errand_id`
  - `POST /batches` (Id; several errands sharing one trip, never one card or escrow)
- **Disputes:** `POST /disputes` (Id), `GET /disputes/mine`

**Money**
| Method | Path | Notes |
|---|---|---|
| GET | /wallet | `Wallet` |
| POST | /wallet/topup | (Id) whole shillings only → 202 `{payment_id, status:"initiated", amount_cents}`; credited by the callback |
| POST | /wallet/withdraw | (Id) → 202; refused beyond the available balance (balance minus withdrawals not yet debited) |
| GET | /earnings | `Earnings` |
| POST | /payouts | (Id) → 202 |
| GET | /payouts/:id, /payments/:id | status |

**Ops** (staff only; each route needs its grant)
- **Read:**
  - `GET /ops/overview`
  - `/ops/sos`, `/ops/disputes`, `/ops/disputes/:id/evidence`, `/ops/rulings`
  - `/ops/kyc`, `/ops/kyc/:id`
  - `/ops/errands`, `/ops/errands/:id/trace` (the money trace)
  - `/ops/accounts`, `/ops/accounts/:id`
  - `/ops/finance`, `/ops/export/accounts.csv`
- **Write:**
  - `POST /ops/sos/:id/acknowledge|resolve`
  - `POST /ops/disputes/:id/rule`
  - `POST /ops/kyc/:id/decide`
  - `POST /ops/accounts/:id/suspend|reinstate|make-staff`
  - `PUT /ops/accounts/:id/grants` (never your own)
  - `POST /ops/cards/:id/void` (`legal_ops`)
- **Audit:** every ops write and every location read writes to `audit_log`, which is
  append-only.

**Realtime:** a WebSocket pushes errand, stall, chat and location events to the two parties
only. It is authenticated with the access token and re-checked as in §5.

---

## 9. Worker

Handlers for:
- card loads and the decline ladder
- STK, B2C, withdrawal and callback processing (the callback matches the payment, then posts
  to the ledger)
- settlement and card void
- offer lapse (90 seconds), auction close, evidence timeouts
- notifications (push and SMS, in English or Swahili)
- payouts and their reversal on failure

**Hourly retention** (§11). **Nightly reconciliation** compares the ledger, the issuer's card
balances and M-Pesa:
- serious findings page
- minor findings open a ticket
- a clean run records 0 findings

The worker connects as `sidequest_worker`, with RLS like any other role.

---

## 10. Clients

### 10.1 Mobile app (Expo, iOS and Android)

**Parity rule:** brand is shared, chrome is native.
- Every iOS/Android difference lives in one file, `src/platform/adaptive.ts`.
- A lint script fails the build on any `Platform.OS` or `Platform.select` elsewhere.
- The same script checks that the English and Swahili string files have identical keys and
  `{placeholders}`.

**Requester shell:**
- **iOS:** five bottom tabs including Post.
- **Android:** four tabs with a Material 3 pill indicator, and Post as a floating action
  button.

**Stall approval sheet.** Identical on both platforms, in this order:
1. stall name
2. stall count
3. photo
4. line items with prices
5. total
6. remaining cap
7. Approve
8. Substitute
9. Decline

Only the button height and the drag handle adapt. Write a render test that fails if the order
changes.

**Destructive confirms:**
- **iOS:** an action sheet.
- **Android:** a Material 3 dialog with the confirming action last.
- **On both:** tapping the scrim does not dismiss it, and nothing destructive has default
  focus.

**Screens:**
- **Sign-in:** phone, then code, name and role, plus the legal checkbox (§11).
- **Requester:** home, post an errand (a stall and item builder), activity, wallet with top-up
  and withdraw, profile.
- **Runner:** feed, active errand, earnings and payout, profile.
- **Errand in flight:** a full-screen modal with a live card showing stall progress, the ETA,
  a live map, chat, SOS and the handover QR. The runner side has the QR scanner.
- **Runner flow:** camera capture at each stall.
- **KYC:** document capture and submit.
- **Batch trip planner.**
- **Profile:** privacy controls (§11).

**Platform behaviour:**
- **Session.** Tokens: refresh token in the device keychain, this device only; memory only on
  web. One silent refresh in flight at a time.
- **Push.** Expo push, with an explanation screen before the permission prompt. Tapping a
  notification opens its errand, including when the tap launched the app.
- **Accessibility.** Defaults: phone portrait, Android 9+ and iOS 15+, light mode, 48 dp tap
  targets, accessibility roles and labels, reduced motion respected.

### 10.2 Ops console (Next.js)

Pages: overview with daily bars, the SOS queue, disputes with the ruling form, KYC review,
errands, users and staff access, finance, and the money trace for an errand.

- **Ruling form.** Shows editable amounts and live split arithmetic against the frozen escrow,
  and enforces the 40-character rationale.
- **Server-side only.** The console calls the API server to server and keeps tokens in
  httpOnly, SameSite=strict cookies. It refreshes once at a time per process.
- **CSP.** A strict policy with a per-request nonce, and no inline styles.

---

## 11. Legal requirements (Kenya Data Protection Act 2019; App Store and Google Play)

- **Consent at sign-up.** `LEGAL_VERSIONS = { terms: "2026-10-01", privacy: "2026-10-01" }`.
  - `POST /auth/verify` for a new number requires
    `accept_legal: { terms, privacy, adult: true }` matching the current versions exactly.
    Otherwise it returns 400 `LEGAL_ACCEPTANCE_REQUIRED` and creates no account.
  - Record each acceptance with the document, version, `adult` and a timestamp.
  - The app shows an unticked checkbox ("I'm 18 or older and agree to the Terms of Service
    and the Privacy Notice", both linked) and keeps Verify disabled until it is ticked.
- **Re-consent.** When a version changes, `Me.legal_current` is false and the token's `lg`
  claim is false.
  - Reads still work.
  - Writes return 403 `LEGAL_ACCEPTANCE_REQUIRED`, except auth, `/me/legal`, `/me/delete`,
    push-token, location-consent and SOS.
  - The app shows a full-screen "We've updated our terms" screen with Agree and Sign out. Staff
    are exempt.
- **Access.** `GET /me/export` returns `Content-Disposition: attachment` with:
  - `account`, including the caller's own msisdn
  - `legal_acceptances` and `verification` metadata (which documents are held, never the
    images)
  - `errands`, `messages_sent`, `payments`, `ledger` and `notifications`
  - nothing about any other person
- **Erasure.** `POST /me/delete` with `{confirm:"DELETE"}` (400 without it).
  - **Refused (409) while anything is open:**
    - `ACCOUNT_HAS_BALANCE` (wallet or earnings not zero, or payments in flight)
    - `LIVE_ERRANDS`
    - `OPEN_DISPUTE`
    - staff close their accounts through an admin instead (403)
  - **Otherwise, in one SECURITY DEFINER transaction:**
    - delete the KYC rows, then their stored files
    - delete push tokens and live location, and remove precise points from history
    - revoke all sessions
    - pseudonymise the account (`display_name: "Deleted user"`, msisdn freed so the number can
      sign up afresh as a new account)
    - write an erasure log entry
  - **Keep** the ledger, payments and rulings, which tax law requires.
- **Location consent.** Revocable at any time. `movement_consent` plus `movement_consent_at`;
  withdrawing it stops location ingest (403 `CONSENT_REQUIRED`). Callers without an approved
  tier-3 case get `consent: null`, and POST returns 409 `TIER_REQUIRED`.
- **Retention**, hourly, with stored files deleted too:
  - location points: 30 days
  - rejected or expired KYC: 90 days after review
  - chat: 1 year
  - errand photos: 2 years
  - never anything on a live or disputed errand
- **Profile** links the documents and offers location consent, Download my data, and Delete
  account (with a destructive confirm, and reasons when refused). Everything is in English and
  Swahili.

---

## 12. Observability and safety

- **Logs** are JSON, structured, with a request id. A redaction list covers tokens, codes,
  msisdn, secrets, signatures and callback tokens.
- **Metrics** are served in Prometheus text format on an internal endpoint.
- **Code gates in CI:**
  - a secret scan
  - a dependency scan
  - no unscoped database access in route code
  - destructive DDL requires an explicit marker

---

## 13. Tests you must write

- **Domain unit tests:**
  - the state machine (every legal and illegal transition)
  - the fee split, including rounding cases
  - posting groups balance
  - the decline ladder
  - the ETA
- **End-to-end tests** that run the real API in-process and the real worker handlers against
  real Postgres and Redis, as the RLS roles:
  - a full market run from top-up to settlement, with exact ledger balances at every step
  - cancellations and disputes with rulings
  - the auction
  - KYC to tier 3
  - location linking
  - security regressions (cross-tenant reads, idempotency, token reuse, rate limits)
  - legal and privacy
- **Mobile:** jest-expo tests under both iOS and Android presets, including the parity tests
  of §10.1.

---

## 14. Acceptance (how your build is scored)

Start the stack in development mode with the API's stdout written to a file:

```sh
redis-cli FLUSHALL
pnpm dev:api > /tmp/api.log 2>&1 &
pnpm dev:worker &
node acceptance.mjs --api http://localhost:3000 --otp-log /tmp/api.log
```

The suite has 27 black-box checks across five areas: platform, sign-in and sessions,
errands, money, and privacy and legal. It exits 0 only when all pass. Beyond it, builds are
compared on the rubric in `README.md`, so the business rules, RLS, tests and clients count too.

**Definition of done**
- `pnpm verify` is green.
- Migrations apply on an empty database, and a second run is a no-op.
- The acceptance suite passes 27/27.
- The app runs in Expo Go or on the web (`w`).
- `README.md` explains how to run everything, and where you deviated from this prompt and why.

---

## Appendix A — `packages/contracts/src/index.ts` (implement exactly)

```ts
import { z } from 'zod';

const uuid = z.string().uuid();
const cents = z.number().int().nonnegative();
const positiveCents = z.number().int().positive();
const iso = z.string().datetime({ offset: true });

export const ErrandKind = z.enum(['market_run', 'queue_stand', 'document_drop', 'custom']);
export const ErrandStatus = z.enum([
  'draft', 'open', 'awaiting_funds', 'offered', 'awarded', 'en_route', 'shopping',
  'awaiting_approval', 'handover', 'settled', 'cancelled', 'disputed', 'expired',
]);
export const StallStatus = z.enum(['pending', 'photographed', 'approved', 'declined', 'substituted', 'skipped']);
export const TrancheStatusEnum = z.enum(['pending', 'loaded', 'failed', 'reversed']);
export const AssignmentMode = z.enum(['pick', 'open']);
export const Language = z.enum(['en', 'sw']);
export const Role = z.enum(['requester', 'runner']);

// ── auth
export const LEGAL_VERSIONS = { terms: '2026-10-01', privacy: '2026-10-01' } as const;
export const LegalAcceptance = z.object({
  terms: z.literal(LEGAL_VERSIONS.terms),
  privacy: z.literal(LEGAL_VERSIONS.privacy),
  adult: z.literal(true),
});
export const DeleteAccount = z.object({ confirm: z.literal('DELETE') });
export const LocationConsentBody = z.object({ consent: z.boolean() });
export interface LocationConsent { consent: boolean | null; changed_at: string | null }

export const OtpRequest = z.object({ msisdn: z.string().min(9).max(16) });
export const OtpVerify = z.object({
  challenge_id: uuid,
  code: z.string().regex(/^\d{6}$/),
  device_id: z.string().min(8).max(128).optional(),
  role: Role.optional(),
  display_name: z.string().min(1).max(48).optional(),
  staff_only: z.boolean().optional(),
  accept_legal: z.unknown().optional(),   // validated against LegalAcceptance
});
export const PushTokenBody = z.object({
  token: z.string().regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,64}\]$/),
  platform: z.enum(['ios', 'android']),
});
export const RefreshRequest = z.object({ refresh: z.string().min(20).max(200).optional() });
export const PatchMe = z.object({
  display_name: z.string().min(1).max(48).optional(),
  language: Language.optional(),
  role: Role.optional(),
}).refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export interface OtpChallenge { challenge_id: string; expires_at: string }
export interface Me {
  id: string; display_name: string; role: 'requester' | 'runner' | 'staff';
  verification_tier: 0 | 1 | 2 | 3; entitlements: string[]; language: 'en' | 'sw';
  market: string; legal_current: boolean;
}
export interface Session { access: string; refresh: string; expires_in: number; account: Me }

// ── KYC
export const KycSlot = z.enum(['id_front', 'id_back', 'selfie', 'conduct_cert']);
export const CreateKycCase = z.object({ target_tier: z.number().int().min(2).max(3) });
export const PresignDocument = z.object({ slot: KycSlot, content_type: z.enum(['image/jpeg', 'image/png', 'application/pdf']) });
export const SubmitKyc = z.object({
  id_number: z.string().regex(/^\d{6,10}$/).optional(),
  next_of_kin: z.object({ name: z.string().min(1).max(48), msisdn: z.string().min(9).max(16) }).optional(),
  movement_consent: z.boolean().optional(),
});
export interface KycCase { id: string; target_tier: number; status: string; reject_reason: string | null; slots: Record<string, boolean>; created_at: string }
export interface Presigned { upload_url: string; object_key: string; expires_in: number; headers: Record<string, string> }

// ── errands
const Point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), label: z.string().min(1).max(120) });
export const CreateErrand = z.object({
  kind: ErrandKind,
  title: z.string().min(1).max(120),
  notes: z.string().max(1000).optional(),
  pickup: Point.optional(),
  dropoff: Point,
  spend_cap_cents: cents,
  max_fee_cents: positiveCents,
  deadline_at: iso.optional(),
  bonus_cents: cents.max(100_000).default(0),
  auction_minutes: z.number().int().min(5).max(60).default(15),
  assignment_mode: AssignmentMode.default('pick'),
  stalls: z.array(z.object({
    seq: z.number().int().min(1).max(20),
    name: z.string().min(1).max(80),
    till_number: z.string().regex(/^\d{5,9}$/).optional(),
    items: z.array(z.object({ label: z.string().min(1).max(80), qty: z.number().positive().max(9999), unit: z.string().min(1).max(16) })).min(1).max(40),
  })).max(20).default([]),
});
export const FundErrand = z.object({ rail: z.enum(['wallet', 'mpesa_stk']) });
export const PlaceBid = z.object({ fee_cents: positiveCents, eta_minutes: z.number().int().min(1).max(600), note: z.string().max(280).optional() });
export const AwardBid = z.object({ bid_id: uuid });
export const Offer = z.object({ runner_id: uuid, fee_cents: positiveCents });
export const Invite = z.object({ runner_id: uuid, fee_cents: positiveCents });
export const CancelErrand = z.object({ reason: z.string().max(280).optional() });
export const FeedQuery = z.object({
  lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180),
  radius_m: z.coerce.number().int().min(200).max(10_000).default(3000),
});
export const NearbyQuery = z.object({ errand_id: uuid, radius_m: z.coerce.number().int().min(200).max(10_000).default(3000) });

export interface LineItem { id: string; label: string; qty: number; unit: string; price_cents: number | null; substituted_for_label: string | null; accepted: boolean | null }
export interface Stall { id: string; seq: number; name: string; till_number: string | null; status: z.infer<typeof StallStatus>; total_cents: number; photo_url: string | null; evidence_attempts: number; items: LineItem[] }
export interface Tranche {
  id: string; seq: number; stall_id: string; amount_cents: number; status: z.infer<typeof TrancheStatusEnum>;
  reimbursement_confirmed: boolean | null; attempts: { rung: string; result: string; code: string | null; at: string }[];
}
export interface Counterparty { id: string; display_name: string; verification_tier: number }
export interface ErrandSummary {
  id: string; kind: z.infer<typeof ErrandKind>; status: z.infer<typeof ErrandStatus>; title: string;
  spend_cap_cents: number; spent_cents: number; max_fee_cents: number; agreed_fee_cents: number | null;
  bonus_cents: number; deadline_at: string | null; created_at: string;
  stall_count: number; stalls_done: number; role: 'requester' | 'runner';
  counterparty_name: string | null; stall_states: z.infer<typeof StallStatus>[]; eta_at: string | null;
}
export interface ErrandDetail extends ErrandSummary {
  notes: string | null; assignment_mode: 'pick' | 'open'; funding_mode: 'upfront' | 'tranche';
  pickup: { lat: number; lng: number; label: string | null } | null;
  dropoff: { lat: number; lng: number; label: string };
  auction_closes_at: string | null; offered_to: string | null;
  requester: Counterparty; runner: Counterparty | null;
  stalls: Stall[]; tranches: Tranche[];
  escrow: { funded_cents: number; held_cents: number; frozen: boolean } | null;
  fee: { requester_fee_cents: number; runner_fee_cents: number } | null;
  eta: { percent_complete: number; eta_at: string | null; confidence: 'high' | 'medium' | 'low' } | null;
  card: { last4: string; loaded_cents: number; voided: boolean } | null;
}
export interface FeedItem {
  id: string; kind: z.infer<typeof ErrandKind>; title: string; spend_cap_cents: number; max_fee_cents: number;
  bonus_cents: number; deadline_at: string | null; distance_band: string; stall_count: number;
  auction_closes_at: string | null; my_bid_cents: number | null;
}
export interface NearbyRunner { runner_id: string; display_name: string; distance_band: string; cell_r9: string; completed_with_you: number; fix_age_seconds: number }
export interface BidView { id: string; runner: Counterparty & { completed_jobs: number }; fee_cents: number; eta_minutes: number; note: string | null; status: string }
export type BidsResponse = { sealed: true; count: number; closes_at: string } | { sealed: false; bids: BidView[] };

// ── stalls and approval
export const PriceItems = z.object({ items: z.array(z.object({ id: uuid, price_cents: cents })).min(1).max(40) });
export const EvidenceRequest = z.object({
  kind: z.enum(['goods', 'receipt']), content_type: z.enum(['image/jpeg', 'image/png']), taken_at: iso,
  lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(),
});
export const DeclineStall = z.object({ reason: z.string().min(1).max(280) });
export const Substitute = z.object({ line_item_id: uuid, label: z.string().min(1).max(80), qty: z.number().positive().max(9999), unit: z.string().min(1).max(16), price_cents: cents });
export const ReimbursementConfirm = z.object({ tranche_id: uuid, accept: z.boolean() });
export const Handover = z.object({ qr_token: z.string().min(10).max(200) });
export interface ApproveResponse { tranche: { id: string; seq: number; amount_cents: number; status: 'pending' }; remaining_cap_cents: number; poll_after_ms: number }
export interface HandoverToken { qr_token: string; expires_at: string; rotates_in_ms: number }

// ── link and location
const b64 = z.string().regex(/^[A-Za-z0-9+/=_-]+$/).max(200);
export const LinkPublish = z.object({ public_key: b64 });
export const LinkAck = z.object({ link_hash: b64 });
export const LocationFix = z.object({
  errand_id: uuid, lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180),
  accuracy_m: z.number().min(0).max(10_000), heading_deg: z.number().min(0).max(360).nullable().default(null),
  seq: z.number().int().nonnegative(), hmac_tag: b64, recorded_at: iso,
});
export const LocationBatch = z.object({ fixes: z.array(LocationFix).min(1).max(4) });
export interface LinkState { state: 'pending_keys' | 'pending_ack' | 'active' | 'revoked'; counterpart_key: string | null }
export interface LocationView {
  state: 'live' | 'linked_stale' | 'revoked' | 'pending';
  point?: { lat: number; lng: number; accuracy_m: number | null }; seq?: number; hmac_tag?: string; recorded_at?: string; age_seconds?: number;
}

// ── money
export const TopUp = z.object({ amount_cents: positiveCents.max(15_000_000) });
export const Withdraw = z.object({ amount_cents: positiveCents });
export const PayoutRequest = z.object({ amount_cents: positiveCents });
export interface Wallet {
  currency: string; balance_cents: number;
  escrow: { errand_id: string; title: string; held_cents: number }[];
  recent: { id: string; reason: string; amount_cents: number; at: string }[];
}
export interface Earnings {
  currency: string; available_cents: number; reimbursements_owed_cents: number; lifetime_cents: number;
  payouts: { id: string; amount_cents: number; status: string; at: string }[]; min_payout_cents: number;
}

// ── chat, safety, disputes
export const SendMessage = z.object({ body: z.string().min(1).max(1000) });
export interface Message { id: string; sender_id: string; body: string; at: string }
export const Sos = z.object({ lat: z.number().optional(), lng: z.number().optional() });
export const OpenDispute = z.object({
  errand_id: uuid,
  reason: z.enum(['goods_wrong', 'goods_missing', 'overcharged', 'no_show', 'safety', 'other']),
  detail: z.string().min(1).max(2000),
});

// ── ops
export const KycDecision = z.object({ approve: z.boolean(), tier: z.number().int().min(1).max(3).optional(), reason: z.string().max(280).optional() });
export const STAFF_GRANTS = ['ops.read', 'kyc.review', 'evidence.view', 'ledger.read', 'location.read_cells',
  'audit.read', 'legal_ops', 'accounts.manage', 'staff.admin'] as const;
export const StaffGrants = z.object({ grants: z.array(z.enum(STAFF_GRANTS)).max(STAFF_GRANTS.length) });
export const Suspension = z.object({ reason: z.string().trim().min(8).max(280) });
export const SosResolve = z.object({ note: z.string().trim().min(4).max(1000) });
export const Ruling = z.object({
  outcome: z.enum(['requester_favour', 'runner_favour', 'split', 'void']),
  requester_cents: cents, runner_cents: cents, rationale: z.string().min(40).max(4000),
});

// ── errors
export interface Problem { type: string; title: string; status: number; code: string; details?: Record<string, unknown>; request_id?: string }
export const ERROR_CODES = [
  'OTP_INVALID', 'OTP_THROTTLED', 'TIER_REQUIRED', 'ERRAND_STATE_INVALID', 'SPEND_CAP_EXCEEDED',
  'BID_CLOSED', 'RETAKE_EXHAUSTED', 'CARD_DECLINED', 'INSUFFICIENT_ESCROW', 'INSUFFICIENT_FUNDS',
  'PAYOUT_FAILED', 'IDEMPOTENCY_CONFLICT', 'RATE_LIMITED', 'NOT_FOUND', 'FORBIDDEN',
  'ALREADY_ASSIGNED', 'LINK_NOT_ESTABLISHED', 'CONSENT_REQUIRED', 'VALIDATION',
  'LEGAL_ACCEPTANCE_REQUIRED', 'ACCOUNT_HAS_BALANCE', 'LIVE_ERRANDS', 'OPEN_DISPUTE',
] as const;
```

## Appendix B — the errand state machine (`packages/domain/src/errand/machine.ts`)

```ts
type S = 'draft' | 'open' | 'awaiting_funds' | 'offered' | 'awarded' | 'en_route' | 'shopping'
  | 'awaiting_approval' | 'handover' | 'settled' | 'cancelled' | 'disputed' | 'expired';
type Actor = 'requester' | 'runner' | 'system' | 'legal_ops';

const TRANSITIONS: { from: S; event: string; to: S; by: Actor[] }[] = [
  { from: 'draft',             event: 'publish',            to: 'awaiting_funds',    by: ['requester'] },
  { from: 'draft',             event: 'cancel',             to: 'cancelled',         by: ['requester'] },
  { from: 'awaiting_funds',    event: 'fund',               to: 'open',              by: ['system'] },
  { from: 'awaiting_funds',    event: 'cancel',             to: 'cancelled',         by: ['requester'] },
  { from: 'open',              event: 'offer',              to: 'offered',           by: ['requester'] },
  { from: 'offered',           event: 'offer_lapsed',       to: 'open',              by: ['system', 'runner'] },
  { from: 'open',              event: 'award',              to: 'awarded',           by: ['requester'] },
  { from: 'open',              event: 'accept',             to: 'awarded',           by: ['runner'] },
  { from: 'offered',           event: 'accept',             to: 'awarded',           by: ['runner'] },
  { from: 'open',              event: 'auction_expired',    to: 'expired',           by: ['system'] },
  { from: 'open',              event: 'cancel',             to: 'cancelled',         by: ['requester'] },
  { from: 'offered',           event: 'cancel',             to: 'cancelled',         by: ['requester'] },
  { from: 'awarded',           event: 'start',              to: 'en_route',          by: ['runner'] },
  { from: 'awarded',           event: 'cancel',             to: 'cancelled',         by: ['requester', 'runner'] },
  { from: 'en_route',          event: 'arrive',             to: 'shopping',          by: ['runner'] },
  { from: 'en_route',          event: 'cancel',             to: 'cancelled',         by: ['requester', 'runner'] },
  { from: 'shopping',          event: 'submit_stall',       to: 'awaiting_approval', by: ['runner'] },
  { from: 'awaiting_approval', event: 'submit_stall',       to: 'awaiting_approval', by: ['runner'] },
  { from: 'awaiting_approval', event: 'approve_stall',      to: 'shopping',          by: ['requester'] },
  { from: 'awaiting_approval', event: 'decline_stall',      to: 'shopping',          by: ['requester'] },
  { from: 'awaiting_approval', event: 'reject_photo',       to: 'shopping',          by: ['requester'] },
  { from: 'awaiting_approval', event: 'all_stalls_done',    to: 'handover',          by: ['system'] },
  { from: 'shopping',          event: 'all_stalls_done',    to: 'handover',          by: ['system'] },
  { from: 'shopping',          event: 'ready_for_handover', to: 'handover',          by: ['runner'] },
  { from: 'handover',          event: 'handover_scanned',   to: 'settled',           by: ['runner'] },
  { from: 'awarded',           event: 'raise_dispute',      to: 'disputed',          by: ['requester', 'runner'] },
  { from: 'en_route',          event: 'raise_dispute',      to: 'disputed',          by: ['requester', 'runner'] },
  { from: 'shopping',          event: 'raise_dispute',      to: 'disputed',          by: ['requester', 'runner'] },
  { from: 'awaiting_approval', event: 'raise_dispute',      to: 'disputed',          by: ['requester', 'runner'] },
  { from: 'handover',          event: 'raise_dispute',      to: 'disputed',          by: ['requester', 'runner'] },
  { from: 'settled',           event: 'raise_dispute',      to: 'disputed',          by: ['requester', 'runner'] },
  { from: 'disputed',          event: 'resolve_dispute',    to: 'settled',           by: ['legal_ops'] },
  { from: 'en_route',          event: 'deadline_passed',    to: 'en_route',          by: ['system'] },
  { from: 'shopping',          event: 'deadline_passed',    to: 'shopping',          by: ['system'] },
];

export function nextStatus(from: S, event: string, by: Actor): S {
  const t = TRANSITIONS.find((x) => x.from === from && x.event === event && x.by.includes(by));
  if (!t) throw Object.assign(new Error(`Cannot ${event} an errand in state "${from}" as ${by}`), { code: 'ERRAND_STATE_INVALID' });
  return t.to;
}
```

## Appendix C — reference: the fee split (`packages/domain/src/pricing/fees.ts`)

```ts
function roundHalfEven(v: number): number {
  const f = Math.floor(v), d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
export function splitFee(baseCents: number, rateBps = 1200) {
  if (rateBps < 0 || rateBps > 3000) throw new Error(`Implausible fee rate ${rateBps} bps`);
  const total = roundHalfEven((baseCents * rateBps) / 10_000);
  const runnerHalf = Math.trunc(total / 2);
  return { baseCents, rateBps, requesterFeeCents: total - runnerHalf, runnerFeeCents: runnerHalf, totalTakeCents: total };
}
export function depositTotal(a: { agreedFeeCents: number; goodsCapCents: number; bonusCents: number; rateBps?: number }) {
  const split = splitFee(a.agreedFeeCents, a.rateBps);
  return { split, depositCents: a.agreedFeeCents + a.goodsCapCents + a.bonusCents + split.requesterFeeCents };
}
// splitFee(40_000) → { requesterFeeCents: 2400, runnerFeeCents: 2400, totalTakeCents: 4800 }
// depositTotal({ agreedFeeCents: 40_000, goodsCapCents: 100_000, bonusCents: 0 }).depositCents → 142_400
```
