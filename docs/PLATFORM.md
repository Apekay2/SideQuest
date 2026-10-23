# Side Qwest — Platform Document

> **Errands in Nairobi, paid through escrow.** A requester posts an errand, a verified runner
> does it stall by stall, and every shilling moves through a double-entry ledger.

| | |
|---|---|
| **Version** | 2.0, 23 October 2026. Replaces `sideqwest-complete-platform.md` v1.0 ([why](DECISIONS.md#fd-01--the-code-is-the-source-of-truth-not-the-pitch-documents)) |
| **Repository** | `Apekay2/SideQuest`: a TypeScript monorepo |
| **Status** | MVP code complete for a Nairobi pilot. CI green. **Not launched.** Needs a payments partner, counsel-reviewed terms, ODPC registration, provider credentials and native builds before any real money moves |
| **Rule for this document** | Every claim names the code that does it, or is marked *not built* |

---

## 1. What Side Qwest is

**One line.** A Nairobi errand marketplace where the requester's money sits in escrow and is
released stall by stall against photographed baskets, with a QR handover as proof of
delivery.

**What exists today.**
- A mobile app (Expo, iOS and Android, English and Swahili) with requester and runner modes.
- An API (Fastify) and a worker (BullMQ) over Postgres with PostGIS and h3, and Redis.
- An ops console (Next.js) for KYC review, disputes and rulings, SOS, users, finance and
  money traces.
- 12 SQL migrations with row-level security on every table, and CI gates for RLS coverage,
  currency invariants and an append-only ledger.
- End-to-end tests that run the real API and worker against real Postgres and Redis, as the
  RLS-bound roles.

**What does not exist** (and is not claimed):
- per-errand insurance;
- a card-issuer integration (the pilot pays vendors by M-Pesa till instead, see §7);
- a recipient handover for when the requester is not at the door;
- app attestation, root detection or certificate pinning;
- any market other than Kenya.

## 2. Product decisions, as built

| # | Decision | Where it lives |
|---|---|---|
| P1 | Fee: 12% of the agreed runner fee, split evenly. The requester pays 6% on top and 6% is deducted from the runner. Frozen per errand at assignment | `domain/pricing/fees.ts`, `errand_fee`, `PLATFORM_FEE_BPS` |
| P2 | Assignment: **pick** (offer to one runner, 90 s), **open** (first tier-3 claim wins), or a **sealed auction** (bids sealed until close, then the requester awards) | `assignment.routes.ts`, `errands.routes.ts` |
| P3 | Funding: the whole deposit (goods cap + maximum fee + bonus + requester fee) goes into escrow before the errand opens, from the wallet or by M-Pesa STK | `/errands/:id/fund`, `payments.ts` |
| P4 | Market runs release money stall by stall. The runner prices items and photographs the basket; the requester approves, substitutes, asks for one retake, or declines | `stalls.routes.ts` |
| P5 | Spending: a per-errand card when an issuer exists; otherwise the vendor's M-Pesa till; otherwise cash the requester approves, reimbursed at settlement. Capped, never silent | `domain/card/decline-ladder.ts` |
| P6 | Delivery proof: a QR on the requester's phone that rotates every 60 s, scanned by the runner. Settlement follows the scan | `handover.routes.ts` |
| P7 | No release by timer. A stuck errand becomes a system dispute | `jobs/safety.ts` watchdog |
| P8 | Disputes freeze escrow; only `legal_ops` rules; 72 h window after handover; one ruling per errand | `safety.routes.ts`, `ops.routes.ts` |
| P9 | Verification tiers 0–3; tier 3 (card + live location) needs two officers | `kyc/entitlements.ts`, `/ops/kyc/:id/decide` |
| P10 | Payouts go only to the account's own M-Pesa number; minimum KSh 100; five a day | `wallet.routes.ts` |
| P11 | Live location only between the two parties of a live errand, after a key handshake, with the runner's revocable consent | `location.routes.ts`, `useLink.ts` |

## 3. Architecture

```
Expo app (requester / runner)        Ops console (Next.js, staff only)
        │  bearer JWT (15 min)                 │  httpOnly cookies, server-to-server
        ▼                                      ▼
Fastify API ── every query runs inside withActor() ──► Postgres 16 + PostGIS + h3 (RLS forced)
   │   rate limits, idempotency keys, CORS/CSRF/CSP                ▲
   │   writes job rows in the same transaction (outbox)            │ sidequest_worker role
   ▼                                                               │
Redis 7 ◄── outbox poller ── BullMQ worker: card ladder, settlement, payouts, notifications,
   (queues, rate limits, pub/sub for sockets)      reconciliation, retention, SOS paging, watchdog
External: Safaricom Daraja (STK, B2C, B2B till) · Africa's Talking (SMS) · Expo push · Cloudflare R2
```

**Database roles.** `sidequest_app` serves the API's user paths, `sidequest_ops` the
console, and `sidequest_worker` the jobs. `sidequest_definer` (NOLOGIN) owns the
security-definer helpers and the ledger triggers. No role has BYPASSRLS. The ledger tables
are append-only for every login role.

**Geospatial.**
- H3 res-8 narrows nearby-runner search, and the ring count covers the requested radius.
  PostGIS decides the actual distance.
- Responses give distance bands, never metres.
- Runner positions shown to requesters are res-8 cells.
- An errand that has no pickup point appears in the feed at its res-8 cell centre, never at
  the door.

**Realtime.** One WebSocket per device, authenticated by its first message, with the session
re-checked every minute. At most five sockets per account. Every event can also be reached
by polling.

## 4. The trust stack, as built

| Layer | What it does | Code |
|---|---|---|
| Phone identity | OTP sign-in (5 a hour per number, 3 tries a challenge). Refresh tokens rotate, and reuse revokes the whole family | `auth.routes.ts` |
| Tiered KYC | ID front and back, selfie; tier 3 adds a conduct certificate, next of kin and movement consent. Human review, four-eyes for tier 3. ID number and next of kin encrypted with AES-256-GCM | `kyc.routes.ts`, `ops.routes.ts`, `lib/seal.ts` |
| Escrow + ledger | Every posting group balances (deferred trigger). Client balances can't go negative (deferred trigger, 0012). Client and platform funds are segregated by `fund_class` | `domain/ledger/posting.ts`, migrations 0001/0005/0012 |
| Stall approval | Photo plus itemised prices before any money moves. Over-cap approvals are refused with the shortfall | `stalls.routes.ts`, `domain/card/tranche.ts` |
| QR handover | HMAC token that rotates every 60 s, single use by state transition | `handover.routes.ts` |
| Location link | X25519 keys per errand. Each fix is HMAC-tagged and verified on the receiving phone. The server holds public keys and the link hash, never the shared secret | `domain/errand/link-handshake.ts` |
| SOS | Snapshot of the errand and both parties. SMS to the on-call and an alert every minute until acknowledged (max 15). Dial intent for 999 | `safety.routes.ts`, `jobs/safety.ts` |
| Disputes | Freeze escrow, void the card, evidence pack for officers (every view audited), ruling must split the frozen escrow exactly | `safety.routes.ts`, `ops.routes.ts`, `jobs/money.ts` |
| Reconciliation | Nightly. Ledger meaning (signs, cleared liabilities, segregation), operational consistency, issuer balances, unconfirmed rail outcomes, unacknowledged SOS. Findings page or ticket | `jobs/reconcile.job.ts` |

## 5. Errand lifecycle

```
draft → awaiting_funds → open ──offer──► offered ──accept──► awarded → en_route → shopping
                          │  ◄──lapse/decline──┘     ▲          │                  │ ⇅ awaiting_approval
                          ├──award (sealed auction)──┤          │                  ▼
                          └──accept (open mode)──────┘          │               handover ──QR scan──► settled
open/offered ── no taker ──► expired (escrow refunded)          │
draft…en_route ── cancel ──► cancelled                           └─ any live state ── dispute (party or system) ──► disputed ──ruling──► settled
```

Every transition is in `domain/errand/machine.ts`, and an unlisted one throws. A system
dispute is raised after 24 h in `handover`, or 12 h in `awarded`, `en_route`, `shopping` or
`awaiting_approval`, with no progress.

## 6. The money flow (KES)

Worked example: a market run with a KSh 1,000 goods cap and a KSh 400 maximum fee. A runner
is awarded at KSh 300. Two stalls come to KSh 550 and KSh 300.

| Step | Ledger movement |
|---|---|
| Fund | Wallet → escrow: 1,000 cap + 400 max fee + 24 requester fee on the max (6%) = **1,424** |
| Assign at 300 | Fee frozen: requester 18, runner 18 (6% each of 300) |
| Approve stall 1 | Escrow → card float 550, then the card load or till payment captures it to `vendor_paid` |
| Approve stall 2 | Escrow → float 300, captured |
| Handover scan | Settle. Requester fee 18 → platform. Runner earns 300 − 18 = **282**. Escrow refunds 1,424 − 18 − 850 − 300 = **256** to the wallet |
| Platform keeps | 18 + 18 = **36** (12% of 300) |

Unspent card value comes back as the amount the issuer swept when the card was closed. A
runner's cash outlay (the last rung) is a liability that settlement clears into their
earnings, exactly once.

## 7. Paying at the stall — the decline ladder

1. **Card load** (and one retry on a retryable decline). Only when `ISSUER_DRIVER` has an
   adapter. With `none`, the pilot setting, every load declines terminally.
2. **Vendor till** (B2B BuyGoods) from the errand's held balance, when the stall has a till
   number. A timeout waits for the result. After 10 minutes with no result, a human is asked.
   It never falls through to the next rung, which could pay twice.
3. **Cash reimbursement**: the requester approves within 5 minutes and the runner pays cash,
   capped at the remaining spend cap.
4. **Escalate**: the money goes back to escrow, the stall reopens, and both parties are told.

## 8. Business model

Revenue is 12% of agreed runner fees. Goods pass through at cost and are not revenue. Unit
economics have to be rebuilt in KES from pilot data. The inputs:

| Input | Source | Status |
|---|---|---|
| Errands per active requester per month | Pilot | Unknown |
| Average agreed fee | Pilot (auction and claim data) | Unknown |
| M-Pesa collection (STK/paybill), B2C payout and B2B till charges | Safaricom's current tariff for the partner's paybill | Verify before setting the price |
| SMS (OTP, money messages, SOS pages) | Africa's Talking rate | Verify |
| Reserve for losses escrow can't cover | Finance policy (FD-06) | To set |

Contribution per errand = 12% × fee − rail costs − SMS − reserve. If the pilot shows that
contribution is negative at realistic fees, the rate (`PLATFORM_FEE_BPS`) or a minimum fee
changes. Both are configuration.

## 9. Security posture, stated plainly

**In place.**
- RLS forced on every table, with the actor bound per transaction (SET LOCAL). CI asserts
  coverage.
- Short access tokens. Rotating, device-bound refresh tokens with family revocation. Money
  paths and every ops request re-check the session row; ops requests also re-check the live
  grants.
- Idempotency keys on every money POST. Abandoned keys are reported after 2 minutes.
- Sliding-window rate limits in Redis that fail closed on money, OTP and KYC.
- Strict CSP with nonces, an exact-origin CORS allowlist, CSRF origin checks for the cookie
  console, and error scrubbing.
- Daraja callbacks need a secret path token and the published source ranges, and are acted
  on only when they match something we started.
- KYC fields sealed with AES-256-GCM and a key id. Uploads go through presigned URLs with
  server-built keys.
- Metrics only from private addresses or with a token. Secrets validated at boot; production
  refuses development drivers.
- Dependency audit (critical blocks the build), Trivy, gitleaks, and an SBOM per image.

**Not in place.**
- App attestation, root or jailbreak detection, certificate pinning.
- A third-party penetration test.
- A configured key for retired KYC encryption keys (needed before the first key rotation).
- M-Pesa statement reconciliation (needs Daraja's account balance and transaction status
  APIs with production credentials).

**Not claimed.** OWASP ASVS or MASVS compliance.

## 10. Legal and compliance (Kenya)

Checklist, not legal advice. Details are in [RELEASE.md §6](../RELEASE.md#6-legal-obligations).

- **Payments.** Holding wallet and escrow money is a payment service (NPS Act 2011). Launch
  through a CBK-authorised partner holding the float (FD-03).
- **Data protection.**
  - ODPC registration as controller and processor, a DPO, and a DPIA (location and IDs are
    high-risk processing).
  - Safeguards for data held outside Kenya (R2).
  - Breach notification within 72 hours.
- **Built in.**
  - Versioned consent with an 18+ confirmation, and re-acceptance when the terms change.
  - Data export and in-app erasure. Failed deletions are now retried durably.
  - A retention schedule.
- **Tax.** KRA PIN, VAT and digital service tax on fees as they apply. Ledger records are
  kept 7 years and pseudonymised on erasure.
- **Runners.** The terms must set out the contractor relationship. Have an advocate check it
  against the Employment Act and recent gig-work rulings.

## 11. Go-to-market

1. **Nairobi pilot.** One or two neighbourhoods and their markets (for example Kangemi and
   Westlands). Recruit 30–50 tier-3 runners through community channels. Requesters by
   invitation. Operate only during staffed SOS hours.
2. **Measure.** Errands per requester per month, average fee, the share of stalls paid by
   till versus cash, dispute rate, time to SOS acknowledgement, and rail cost per errand.
3. **Decide the rate and the card question** from that data: is a card partner worth it, or
   is till-first enough?
4. **Errands for family** within Kenya first (a requester in Nairobi, a parent in Nakuru).
   This needs the recipient handover (FD-07). The cross-border diaspora corridor comes later
   (FD-02).

## 12. Infrastructure and deployment

- **Images.** API and worker (`infra/docker/node.Dockerfile`), console
  (`infra/docker/console.Dockerfile`), and Postgres with PostGIS and h3
  (`infra/postgres`, `postgres:16-bookworm`). All are non-root.
- **CI** (`.github/workflows/ci.yml`):
  - typecheck, the parity lint, and unit tests;
  - mobile tests under iOS and Android presets;
  - gitleaks and a dependency audit;
  - migrate twice (the second run must be a no-op), then the RLS, currency and ledger gates;
  - end-to-end tests;
  - image builds with an SBOM and a Trivy scan.
- **Runtime.**
  - API: two or more replicas behind TLS, with health checks on `/health/live` and
    `/health/ready`.
  - Worker: one or more replicas. Scheduled work is guarded by a Redis lock: reconciliation
    nightly at 00:00 UTC, retention hourly, the watchdog every 10 minutes.
  - Console: one replica, or several with sticky sessions.
- **Alerting.** Point `ALERT_WEBHOOK_URL` at the on-call tool. Set `SAFETY_ONCALL_MSISDNS`
  (required in production).

## 13. Open items before real money

| Item | Owner |
|---|---|
| Payments partner and float structure (FD-03) | Founder, counsel |
| Counsel-reviewed Terms and Privacy Notice, published at the app's URLs | Counsel |
| ODPC registration, DPO, DPIA | Founder |
| Daraja production app (STK, B2C, B2B BuyGoods enabled), Africa's Talking sender ID, R2, Expo, store accounts | Founder |
| Sandbox proof of the whole money path (RELEASE.md §4) | Engineering |
| Native builds tested on real Android 9 and iOS 15 phones | Engineering |
| Recipient handover (FD-07) before any errands-for-family pilot | Engineering |
| Branch protection, Dependabot, CI failure alerts (FD-16) | Founder |
| Retire the Vercel site's `/api/kyc` and its stored IDs (FD-15) | Founder |
| Penetration test (FD-14) | Founder |
| Staffed SOS rota and on-call numbers (FD-10) | Operations |
