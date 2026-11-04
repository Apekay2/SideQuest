# Founder decision log — production readiness, 23 October 2026

These are the decisions taken during the production-readiness audit
([AUDIT-2026-10-23.md](AUDIT-2026-10-23.md)). Each one covers an area the existing design
documents and pitch materials had overlooked or got wrong. For each it records what was
decided, why, and what already enforces it, so a later change is a deliberate reversal and
not drift.

Status key: **Built** means it is in this repository and covered by a test. **Policy** means
it is an operating rule the code cannot enforce alone. **Blocked** means it waits on someone
outside engineering.

---

## FD-01 · The code is the source of truth, not the pitch documents

**Decision.** Apekay2/SideQuest is Side Qwest. It is a TypeScript monorepo for a Nairobi
launch, paid in KES through M-Pesa. `sideqwest-complete-platform.md` and the Sell-the-Concept
kit describe a different system: Java 21 microservices for a UK→Nigeria corridor, with
Stripe, Persona, Zego, Twilio, Mapbox, Kafka and Temporal. That system does not exist.
[PLATFORM.md](PLATFORM.md) replaces the old document and describes only what this repository
does. The pitch deck has to be rebuilt from PLATFORM.md before anyone outside the company
sees it.

**Why.** The deck says *"Your CTO can audit all of it. We'll bring the repo."* A partner's
CTO who opens this repo would find a different language, a different market and different
providers. The old document also claims things that are not true of any code: "OWASP ASVS L2
✅ / MASVS L2 ✅", "100% of requirements met", "insurance on every errand", "five-way
reconciliation", "root detection and attestation", "18 months of engineering" and
"Everything claimed in this document is traceable to working code". Overstating to a
counterparty during due diligence is a legal risk as well as a credibility risk.

**Status.** Built (PLATFORM.md). Policy: retire the old document and kit.

## FD-02 · Launch in Nairobi first; the diaspora corridor comes later

**Decision.** The first market is Nairobi (KES, M-Pesa, English and Swahili), because that
is what is built and tested. The UK→Nigeria and other diaspora corridors are a later phase.
They are not "built" and must not be pitched as built.

**What the corridor would need.** A GBP or other sending-currency collection rail. A payout
rail in the destination country. The receiving market's licences. The recipient-handover flow
in FD-07, because the person paying is not at the door. The currency module (`0005`, the
`market` table) already separates market from currency, so the money core doesn't change.

**Status.** Policy.

## FD-03 · Customer money is held through a licensed partner

**Decision.** In Kenya, holding wallet and escrow balances is a payment service under the
National Payment System Act 2011. Side Qwest will not take a single real shilling until the
float sits with a CBK-authorised partner: a PSP, or a bank trust or escrow account behind the
M-Pesa paybill. Applying for its own authorisation can run in parallel.

**Why the code is ready for it.** Every posting carries a `fund_class` (client or platform),
and reconciliation asserts that the two are segregated. Since this audit, the database also
refuses any commit that would take a client balance below zero (FD-12). That is the evidence
a partner's safeguarding review will ask for.

**Status.** Blocked (partner and counsel). Built (segregation and invariants).

## FD-04 · Pilot with no card partner: the vendor's till first

**Decision.** There is no card-issuer adapter in this build. Until a card issuer (BIN
sponsor) is signed, the pilot runs with `ISSUER_DRIVER=none`. The decline ladder goes
straight from a card attempt that cannot succeed to the vendor's M-Pesa till (B2B
BuyGoods), and from there to cash the requester approves and that is reimbursed at
settlement. Virtual cards come back when the issuer adapter ships.

**Why.** The worker used to build the *mock* issuer whatever `ISSUER_DRIVER` said. A
production deployment configured for a live issuer would have "loaded" cards that existed
only in Redis and recorded vendor payments that never happened. The worker now refuses to
start with a driver it has no adapter for, and `none` is a real, tested configuration.
Kenyan market vendors overwhelmingly take M-Pesa, so till payment matches how the market
already pays.

**To confirm with Safaricom.** B2B BuyGoods has to be enabled on the paybill at Daraja
go-live.

**Status.** Built (`NoCardIssuer`, `issuerFor`, test *ISSUER_DRIVER=none: the ladder starts
at the vendor till*).

## FD-05 · The fee is the two-sided 12% that is built, and the pitch changes

**Decision.** The platform takes 12% of the runner's agreed fee, split evenly. The requester
pays 6% on top at deposit and 6% is deducted from the runner at settlement. Goods pass
through at cost and tips are not cut. The rate is `PLATFORM_FEE_BPS`, so a change is
configuration, not code, and the fee is frozen per errand at assignment. The pitch's "flat
10% deducted from the runner" is withdrawn.

**Worked example.** A KSh 300 fee: the requester deposits KSh 318 plus the basket cap, the
runner receives KSh 282, and the platform keeps KSh 36.

**Why not 10%.** Changing the split means changing `fees.ts`, the ledger shape and their
tests for an untested guess. The pilot is how the rate gets validated. Rail costs (M-Pesa
collection, B2C and B2B charges) come out of the platform's 12% and have to be modelled from
Safaricom's current tariff before a price is fixed.

**Status.** Built. Policy: rebuild the unit economics in KES (see PLATFORM.md §8).

## FD-06 · No insurance claim until there is an insurer

**Decision.** The product does not offer insurance and no material may say it does. For the
pilot, goods risk is limited to the spend cap and handled by disputes and Legal Operations
rulings over frozen escrow. A loss the escrow cannot cover is paid from a platform trust
reserve, which is a finance policy, not code. A micro-insurance partner is pursued after the
pilot, with real loss data.

**Status.** Policy.

## FD-07 · A handover for when the requester isn't at the door

**Decision.** Today the requester shows a rotating QR code and the runner scans it. That
proves delivery, but only when the requester is standing there. The errand-for-family use
case (the requester is elsewhere, Mum is at the door) needs a recipient mode: the requester
names a recipient, the recipient gets a one-time six-digit code by SMS, and the runner enters
it. This is the next feature after this PR and comes before any errand-for-family pilot.

**Status.** Next feature (not built).

## FD-08 · Money is released on proof of handover, never on a timer

**Decision.** There is no "30-minute auto-release". The runner is paid when the handover is
proven by the QR scan, or by the code in FD-07. An errand that cannot finish goes to a person
instead. The watchdog opens a system dispute when an errand has sat 24 hours in `handover`,
or 12 hours in `awarded`, `en_route`, `shopping` or `awaiting_approval`. For an errand with a
deadline, the clock starts at the deadline, so a job booked for Friday isn't "stuck" on
Tuesday. The dispute freezes escrow and voids the card, and Legal Operations rules.

**Why.** Before this, nothing released money held by a requester who never produced the QR,
or by a runner who disappeared mid-run. A timer that pays out without proof would turn every
no-show into a payout. A watchdog that hands the case to a person doesn't.

**Status.** Built (`jobs/safety.ts` watchdog, `STUCK_AFTER_HOURS`, migration 0012 §2).

## FD-09 · Disputes have a window and an end

**Decision.**
- A settled errand can be disputed for `DISPUTE_WINDOW_HOURS` (72) after handover.
- An errand gets one ruling. An appeal goes to support, not back into the queue.
- The system can raise a dispute (FD-08). `dispute.origin` records who raised it.

**Why.** Before this, a settled errand could go settled → disputed → settled again and
again, re-freezing it and re-queueing it for Legal Operations each time.

**Status.** Built (tests *disputes have an end*).

## FD-10 · An SOS pages a human, and launch hours follow staffing

**Decision.** An SOS texts every number in `SAFETY_ONCALL_MSISDNS` and posts to
`ALERT_WEBHOOK_URL`. It repeats every minute until an officer acknowledges in the console,
up to 15 pages. Production refuses to boot without an on-call number. Reconciliation pages
on any SOS left unacknowledged for 15 minutes. The pilot operates only during hours when the
SOS queue is staffed. Outside those hours the app still offers the emergency number (999) on
SOS, which it already does.

**Why.** An SOS used to write one log line ("page the safety on-call") and nothing else.

**Status.** Built (`pageSos`, config refusal, reconciliation `sos.unacknowledged`). Policy:
staffed hours and the on-call rota.

## FD-11 · KYC: two officers for tier 3, people before vendors

**Decision.** Tier 3 carries the spending card and shares live location with strangers, so
it needs approval from two different officers. Tiers 1 and 2 need one. The pilot reviews
documents by hand. Before scaling, ID checks move to a vendor that can verify against IPRS,
and AML or screening duties are matched to whatever the payments partner (FD-03) requires.

**Status.** Built (four-eyes in `/ops/kyc/:id/decide`, migration 0012 §4, the console's
second-approval queue). Blocked (vendor).

## FD-12 · Ledger invariants live in the database, not only in the code

**Decision.**
- A posting that would take a wallet, earnings, reimbursement liability, errand escrow or
  card float below zero is refused at commit by a deferred trigger.
- Advisory locks stay as the first line of defence. The trigger is the one that cannot be
  forgotten.
- A card void returns exactly what the issuer swept on closure, never a balance read
  earlier.

**Why.** The M-Pesa callback that funds an errand did not take the wallet lock the API takes,
so a withdrawal racing it could spend the same balance twice. The void used to read the card
balance and then void it, so a till tap in between was "refunded" to the requester although
the vendor had been paid.

**Status.** Built (migration 0012 §1, `voidCard` returns `sweptCents`).

## FD-13 · A rail timeout is not a refusal

**Decision.** Every M-Pesa call fails one of two ways. A **rejection** means Safaricom
refused, so it is safe to undo our side. An **unknown outcome** (timeout, dropped connection,
5xx) means the request may have gone through. On an unknown outcome nothing is reversed:
- a B2C payout or withdrawal stays open for its result callback, matched by the
  OriginatorConversationID we sent;
- a till payment waits for its result and asks a human after 10 minutes;
- an STK push stays pending and its callback is matched by the payment id we put on its
  callback URL (Safaricom masks the payer's number, so the number cannot be used); a push
  nobody answers is expired an hour past its expiry, and a late success is still credited.

Reconciliation pages on anything that stays unresolved.

**Why.** A timed-out payout used to be reversed into earnings, so a runner could withdraw the
same money twice if Safaricom had paid. A timed-out STK push used to be marked failed, so a
customer who then paid was never credited.

**Status.** Built (`MpesaRejectedError` and `MpesaUnknownOutcomeError`, originator matching,
reconciliation checks, tests *a rail timeout is not a refusal*).

## FD-14 · No security certifications claimed until they're earned

**Decision.** Side Qwest does not claim OWASP ASVS or MASVS compliance. The mobile app has no
root or jailbreak detection, no Play Integrity or App Attest, and no certificate pinning. For
the pilot that is acceptable: every money decision is made on the server, access tokens last
15 minutes, refresh tokens rotate and are tied to a device, and money paths re-check the
session row. App attestation arrives with card issuing (FD-04), because a card raises the
stakes. A third-party penetration test is needed before public launch.

**Status.** Policy. Blocked (pen test).

## FD-15 · The Vercel site is the marketing site, not a second product

**Decision.** `v0-sideqwest.vercel.app` (the v0 Next.js app on Neon, with Better Auth email
accounts) is a second account system. It also collects national ID numbers into a separate
`kyc_profile` table that has no reviewer workflow. It becomes the marketing and waitlist site
only.
- Its `/api/kyc` is switched off.
- The rows it already holds are reviewed and then deleted, or moved into the app's KYC
  queue. This is personal data with no lawful purpose left.
- All accounts and KYC live in the mobile app and the API.

**Status.** Blocked (Ian: the v0 repository is not reachable from this session).

## FD-16 · CI gates every release, and someone hears when it is red

**Decision.** CI was red on every run from 1 October to 23 October and nobody noticed. The
database job could not build its image, so no migration, RLS gate or end-to-end test ran for
three weeks.
- Protect the release branch: require the `ci` checks to pass and a review before merge.
- Turn on Dependabot alerts.
- Send failed runs to the alert channel.
- After this PR merges, fast-forward `main` to the same commit and make `main` the default
  branch. Today the default is `feat/mvp-build` and `main` is behind it, so it is unclear
  which branch is the release branch.

**Status.** Built (the CI fixes in this PR). Blocked (repository settings: Ian).

## FD-17 · Operating limits are deliberate

**Decision.**
- Payouts: minimum KSh 100, five a day.
- Withdrawals: back to the account's own number only.
- One SOS page per minute.
- Feed: 120 reads an hour.
- Nearby-runner lookups: 30 an hour, at res-8 cells.
- WebSockets: five per account.

Each limit is a named value in code or config, so changing one is a reviewed change.

**Status.** Built.
