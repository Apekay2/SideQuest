# 7. Security

Scoped to this system. Generic advice is omitted — every item below is something a Side Qwest
engineer can act on, and most of them are things that have gone wrong at a comparable
marketplace.

## 7.1 What we are actually protecting

Four assets, in order of what an attacker would want:

1. **Spend authority.** A live card with a loaded balance, or the ability to cause one to load.
2. **Escrow balances.** Other people's money sitting in the platform.
3. **Identity documents.** `kyc_case` holds national ID numbers, selfies and conduct
   certificates for people who are often not in a position to absorb an identity theft.
4. **Live location.** Two parties' real-time positions, tied to real names and phone numbers.

Note what is *not* on this list: errand contents. A shopping list is not worth defending at the
cost of usability.

## 7.2 Threat model by actor

**A malicious runner.** The most likely attacker, because they are inside the flow and the
system hands them spend authority by design.

| Attack | Control |
| --- | --- |
| Spend the card on their own goods | Card is single-errand, ceilinged at `spend_cap`, and loads only per approved stall. Vendor name and amount are captured on the authorisation webhook and reconciled against the stall |
| Photograph someone else's goods | Evidence carries EXIF time and GPS; a fix more than 500 m from the stated market flags for review. Two failed attempts escalate to the requester rather than looping |
| Claim reimbursement for cash never spent | Rung 3 requires explicit requester confirmation inside 5 minutes, is capped at the remaining cap, and every rung writes a `card_attempt` row |
| Spoof GPS to appear near a market | Fixes are HMAC-tagged but the *content* is still device-supplied — see §7.5 |
| Take an errand and disappear | Tier 3 KYC: national ID, conduct certificate, next of kin. Escrow does not release without a handover scan |
| Extract the link secret and forge a location trail | Bounded to one errand, revoked at settlement. Location is not evidence of anything money depends on |

**A malicious requester.**

| Attack | Control |
| --- | --- |
| Receive goods then dispute to reclaim escrow | Handover QR is scanned from the requester's own screen — the scan is the requester's act. Evidence pack shows goods photos, timestamps and the scan |
| Approve nothing, strand the runner mid-market | Approval timers escalate; an errand abandoned in `awaiting_approval` for 30 minutes auto-releases the runner's fee and closes the errand at spent-to-date |
| Harvest runner locations by posting fake errands | Location sharing requires an *assigned* errand and a completed handshake. An unassigned errand shows no live positions at all — the map shows availability by res-9 cell, not a precise point |
| Doxx a runner via repeated pickups | `relationship.blocked` lets a runner refuse a requester permanently, and the block is not disclosed to the requester |

**An outsider.**

| Attack | Control |
| --- | --- |
| Card testing against the issuer | Cards are created by us, never by user input; there is no PAN entry endpoint |
| OTP brute force / SIM swap | 5 OTP per hour per number, 3 code attempts, and a 24-hour cooling period on payouts after a device change |
| Webhook forgery (fake `payment.confirmed`) | Every webhook signature-verified; Daraja restricted to Safaricom source IPs; `payment` rows keyed on `(provider, provider_ref)` so a replay is a no-op |
| Scrape the runner map | `/runners/nearby` requires a funded, published errand and is rate limited to 30/hour; results are capped at 50 and coarsened to res-9 cells until an offer is made |

**A malicious insider.** The one most marketplaces ignore until it happens.

- Ops console is VPN- and SSO-gated, IP-allowlisted, and never exposed to the public internet.
- Every evidence view writes an `audit_log` row with the case, the operator and the timestamp.
- `legal_ops` is the only entitlement that can split a frozen escrow, it is granted to named
  individuals, and a ruling requires a rationale of at least 40 characters that is retained.
- No engineer has standing production database access. Break-glass is a time-boxed role
  assumption that pages the team channel on use.
- KYC document decryption happens in `identity` only, through one function, which logs.

## 7.3 The money path

Beyond the invariants in the README:

- **Velocity limits per errand and per account.** More than 6 tranches on one errand, or more
  than KSh 50,000 loaded to one runner in 24 hours, holds for review rather than declining.
  A hold is visible to both parties with a reason; a silent decline is how you lose runners.
- **Reconciliation is a job, not a hope.** Nightly: issuer balance per open card against
  `card.loaded_cents`; Daraja statement against `payment`; `sum(posting.amount_cents)` across
  the entire ledger against zero. Any mismatch pages, and the sweeper voids orphaned cards.
- **The fee split is frozen at assignment** in `errand_fee`. A rate change cannot retroactively
  alter what someone was quoted.
- **Refunds never exceed the deposit.** Asserted in `refundAfterAssignment`, which throws
  rather than returning a negative.

## 7.4 Location privacy

This is the area where the law and the product are most likely to collide, so it is written as
rules rather than intentions.

- Sharing requires: tier 3, `movement_consent`, an assigned errand, and an active link
  (§1.9). Any one missing and the ingest endpoint returns `403`.
- Consent is revocable in the app at any moment. Revocation stops ingest immediately and
  revokes the link; the errand continues without tracking, and the requester is told that
  tracking ended — not why.
- Precise points are retained 30 days, then nulled with the res-9 cell kept. Res 9 is ~200 m —
  enough for demand analysis, not enough to place someone at an address.
- No location is retained for an *unassigned* runner beyond the 120-second availability TTL in
  Redis. Availability is not a movement history.
- Ops sees cells, not points, except inside an open dispute or SOS case, where the point is
  shown and the view is audited.
- SOS is the one exception to all of the above and is deliberately absolute: it snapshots
  location and both identities regardless of consent state.

## 7.5 GPS spoofing

Worth its own section because the HMAC does not solve it. The tag proves *which device* sent a
fix; it says nothing about whether the GPS chip was lying.

Layered, cheap, and none of them individually conclusive:

- Platform integrity attestation (Play Integrity, App Attest) at session start; a failed
  attestation caps the account at tier 2 (can bid, cannot be awarded).
- Android `isFromMockProvider` on every fix; a single mock fix on an errand voids the on-time
  bonus and flags the run.
- Physics checks in `progress`: implied speed above 120 km/h, or a jump exceeding the elapsed
  time at any plausible speed, discards the fix and increments a counter.
- Corroboration against evidence EXIF, which comes from a different subsystem on the same
  device. Divergence between the two is the strongest single signal.

Response is graded: flag, then withhold the bonus, then hold payouts for review, then suspend.
Never an instant ban on one signal — a matatu through a tunnel produces some of these.

## 7.6 Data protection (Kenya DPA 2019)

Launch blockers, not backlog items:

- Registration with the Office of the Data Protection Commissioner, and a named DPO with a
  published contact.
- Data resident in `af-south-1`. No PII crosses a border, including in logs and error
  reporting — Sentry and OTel scrubbers strip `msisdn`, `id_number`, `lat`, `lng` and
  `display_name` before egress.
- A retention schedule that is enforced by a job, not a policy document: KYC 7 years settled /
  90 days rejected, location points 30 days, evidence 2 years, chat 1 year, ledger indefinite.
- Data subject access and erasure requests answered inside 30 days. Erasure deletes the
  `kyc_case` and pseudonymises `account`; it does not delete ledger rows, and the privacy
  notice says so, because financial records have their own retention basis.
- Consent for location is separate, explicit, revocable, and recorded with a timestamp.

## 7.7 Application hardening

Implemented in `code/api/plugins/hardening.ts`, `rate-limit.ts` and `actor-context.ts`; the
audit that produced them, with the findings each one closes, is `09-appsec-audit.md`.

- **Row-level security on every table**, four roles, none with `BYPASSRLS`, `FORCE RLS` so
  the schema owner is subject too (`03c-rls.sql`). The actor is bound per transaction with
  `SET LOCAL` — never plain `SET`, which leaks the previous request's actor across a
  PgBouncer connection. A request with no actor sees zero rows.
- Access tokens 15 minutes; refresh rotates, and reuse of a spent refresh revokes the whole
  session family and notifies the user.
- Certificate pinning in the mobile app against our API and the PSP's hosted page.
- Link secrets and refresh tokens in Keychain / Keystore with biometric gating on payout.
- All money-moving `POST`s require `Idempotency-Key`; the stored response replays for 24 hours.
- Rate limits: 5 OTP/hour/number, 60 writes/min/account, 300 reads/min/account,
  30 nearby-searches/hour, 4 location fixes per request. The registry in `rate-limit.ts`
  is the authority; money and OTP buckets fail closed when Redis is unavailable.
- Refresh tokens in an `httpOnly`, `Secure`, `SameSite=Strict` cookie scoped to `/auth`;
  access tokens in memory, never `localStorage`. CSP is `default-src 'none'` with a
  per-response nonce and no `unsafe-inline`; CORS is an exact-match allowlist that never
  reflects an arbitrary origin. The console carries `react/no-danger: error`.
- User-supplied text is normalised at the boundary (`domain/text/sanitize.ts`): control and
  bidi characters stripped, names on a positive character class, CSV formula prefixes
  neutralised, SVG never an accepted upload type.
- Every response is `application/problem+json` on error, and no error body ever contains a
  provider message verbatim — issuer decline reasons are mapped to our own codes.
- Secrets in AWS Secrets Manager with rotation; nothing in environment files in the repo;
  no secret has a default, all are checked for placeholder and low-entropy values, and
  `config/env.ts` refuses to boot production with the mock issuer, the Daraja sandbox, a
  non-RLS database role, a plaintext origin or an empty ops IP allowlist. Config redacts
  itself when printed.
- Dependency and container scanning in CI; a failing critical CVE blocks the deploy.

## 7.8 What we are accepting

Stated so nobody discovers it during an incident:

- A rooted device can extract its own link secret and forge that errand's location trail.
- The platform can read location points and errand contents. This is not end-to-end private,
  and the privacy notice must not imply that it is.
- One Postgres cluster means a compromise of the database is a compromise of every service's
  data; schema separation is a blast radius control against *bugs*, not against an attacker
  with database credentials.
- Card and bank rails introduce a PSP that will hold cardholder data on our behalf. Our PCI
  scope is SAQ-A only for as long as we never touch a PAN — the moment anyone proposes a
  card form inside our app, that changes and this section needs rewriting.
