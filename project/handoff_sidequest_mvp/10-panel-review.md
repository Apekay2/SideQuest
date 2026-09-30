# 10. Panel review: current state and global-market readiness

A joint review by the senior engineering, DevSecOps and audit panel over the whole handoff
package — `01`–`09`, the schema migrations, and every file in `code/`. It reports what the
system is now, what was corrected during the review, what remains open, and what changes
when Side Qwest stops being a Kenyan product.

Method: read of all source and schema; trace of the four money paths (top-up, tranche
approval, ladder, settlement) posting by posting; trace of the two assignment paths;
adversarial read of every route against the claims in `07-security.md`; ledger arithmetic
checked by hand against `posting.ts`. No running system was available, so nothing here is a
measured number — where a threshold matters, the panel says what to measure instead of
inventing a figure.

## 10.1 Verdict

The design is materially better than the code that implements it. The architecture documents
describe a system with correct instincts — a transactional outbox, one atomic money module,
frozen fee splits, a derived location link the platform cannot read, an append-only ledger —
and the panel would not change those decisions. What the review found is that several of
those guarantees were asserted in prose and contradicted in code, and that the contradictions
clustered in exactly the places where they cost real money: the outbox lost jobs, settlement
double-debited escrow, and one JavaScript operator turned a per-tranche update into a
whole-table one.

| Area | State | Note |
| --- | --- | --- |
| Domain modelling | Strong | The state machine, the decline ladder and the fee freeze are well judged and well tested in intent |
| Ledger design | Strong, arithmetic was wrong | Double entry, balance trigger, append-only. Two of eight posting builders were incorrect (P-1) |
| Money path integrity | Was unsafe, now defensible | P-1, P-2 and P-4 were all silent-loss defects that reconciliation as specified would not catch |
| Durability | Was unsafe, now correct | The outbox was at-most-once (P-3) |
| Authorisation | Was unsafe, now layered | Pre-review it was application checks only, with two live IDORs (`09-appsec-audit.md` #2, #3) |
| Secrets handling | Good, now enforced | No hardcoded credentials existed at any point. Boot-time refusals now stop weak ones |
| Location privacy | Design excellent, enforcement was absent | `/runners/nearby` contradicted its own security doc in four ways |
| Observability | Thin | Structured logs and OTel are wired; there are no SLOs, no golden signals per money path, no outbox-lag alert until this pass |
| Delivery pipeline | Not evidenced | No CI config, IaC, migration gate or rollback procedure in the package. This is the single largest gap |
| Multi-market readiness | Not started | Single currency by construction, single rail, single jurisdiction, single region. §10.6 |

Pilot readiness: **conditionally yes**, at 50 runners, after the CI gates in `09-appsec-audit.md`
§9.5 exist and the reconciliation additions in §10.5 below are running. The panel would not
put this system in front of 500 runners on its current delivery pipeline, irrespective of code
quality — the code is now better than the team's ability to observe it in production.

## 10.2 Corrected during this review

Each of these was fixed in place, with the reasoning left in the source so the next reader
does not reintroduce it.

**P-1 — Settlement debited escrow twice for every cash reimbursement.** Critical.
`settle()` computed `escrowOut = fee + bonus + reimbursement + refund` and then pushed both a
credit and a debit of `reimbursement_due` for the same amount. The pair cancelled, so the
liability raised earlier by `reimbursementDue()` never cleared, and escrow was debited for the
reimbursement a second time. Every ladder-rung-3 errand overdrew the requester's escrow by the
reimbursed amount. The group still summed to zero, so the deferred balance trigger passed and
the nightly `sum(posting) = 0` check — the only ledger assertion specified in `07-security.md`
§7.3 — passed too. *Fixed in `posting.ts`: escrow releases fee, bonus and refund only; the
liability clears exactly once. `build()` now also rejects a group naming the same account
twice, which is what made the cancellation invisible.*

**P-2 — One JavaScript operator made a per-tranche update global.** Critical.
In the `pay_reimbursement` branch of `card-load.job.ts`:
`.where(eq(cardAttempt.trancheId, trancheId) && eq(cardAttempt.rung, 'reimbursement'))`.
`&&` on two SQL predicate objects evaluates to the second operand, so the statement ran as
`WHERE rung = 'reimbursement'` — marking every pending reimbursement attempt on every errand
in the database as a success, on any single cash reimbursement anywhere in the system. *Fixed
with `and()`. The panel's recommendation is stronger than the fix: ban bare `&&` between
predicates with a lint rule, because this typo is invisible in review and type-checks
cleanly.*

**P-3 — The transactional outbox was at-most-once.** Critical.
The poller marked `dispatched_at = now()` in the same statement that read the batch, then
enqueued. Any failure in between — pod restart, OOM kill, Redis blip, unknown queue name —
dropped the job permanently. The rows at stake are `card.load` (a runner standing in a market
waiting for a card that will never load), `errand.settled` (a runner never paid) and every
notification. Everything upstream is written trusting this component, which is what makes the
defect worse than its size. *Rewritten as claim-with-lease → enqueue → mark dispatched, with
an attempt count, a parked state for poison rows, a re-entrancy guard, and lag gauges.
Migration `03d-outbox-hardening.sql` adds the columns.*

**P-4 — A crash mid-issuer-call stranded loaded cards.** High.
`load_card` inserted a pending attempt, called the issuer, then committed locally. A process
death between the call and the commit left a card holding real money with a tranche reading
`pending`; the retry hit `onConflictDoNothing`, logged "already recorded, replaying" and
returned without reconciling. The runner is never told the card is ready and the ledger never
records the capture — recoverable only by a human reading the issuer's dashboard. *Fixed: the
replay path now asks the issuer what happened by idempotency key (`IssuerPort.getLoad`, added
to the port with `unknown` as a first-class answer), and a single writer records the outcome
for both the live and replay paths. Capture is guarded on `status = 'pending'` so a replay
cannot double-post.*

**P-5 — Unbounded and non-idempotent self-re-enqueues.** Medium.
The ladder re-enqueued itself with no `jobId`, so a webhook and a timer could both wake it and
run the same rung twice. *Fixed: deterministic job ids on every re-enqueue.*

**P-6 — Negative splits lost a cent; escalation could drive `spent_cents` negative.** Medium.
`split(cents(-5), 2)` returned `[-2, -2]`. A ruling splitting a reversal would have failed the
balance trigger at commit — a 500 in front of Legal Operations mid-dispute. Ladder escalation
decremented `errand.spent_cents` unguarded. *Fixed: `split()` rejects negatives with a clear
message; the decrement is floored at zero.*

Also carried over from the security pass in `09-appsec-audit.md`, and still the right
priorities: RLS on every table with the actor bound per transaction, two live IDORs closed,
`/runners/nearby` brought in line with its own privacy claims, and rate limiting implemented
rather than documented.

## 10.3 Open — decide, do not defer

Severity is impact at pilot scale.

| # | Severity | Issue | Panel position |
| --- | --- | --- | --- |
| O-1 | Critical | **No delivery pipeline in the package.** No CI, no IaC, no migration gate, no rollback runbook, no environment promotion. Every control in `07-security.md` and `09-appsec-audit.md` is unenforced without one | Build before the pilot, not after. A codebase this careful with an unmanaged pipeline is a false sense of safety |
| O-2 | Critical | **RLS is unverified against a live database.** The policies are written and tested in intent; nobody has run them | The cross-tenant suite in `code/api/test/security/rls.test.ts` must run green against a real Postgres in CI before the first real errand |
| O-3 | High | **Reconciliation as specified cannot catch P-1's class.** A zero-sum check passes on any balanced group, however economically wrong | Add the per-account assertions in §10.5 |
| O-4 | High | **No SLOs and no money-path alerting.** Nothing pages on approval latency, ladder escalation rate, outbox lag or issuer error rate | Four alerts, listed in §10.5, are the minimum to operate |
| O-5 | High | **Idempotency-Key storage and replay is asserted, not implemented** in this package. Without it, a retried approval on a flaky Nairobi connection can raise two tranches | The conditional-UPDATE pattern protects assignment; approval relies on the key |
| O-6 | Medium | **Daraja callback handler absent.** Source-CIDR config now exists; the handler that must drop non-allowlisted sources *before* signature verification does not | Write it with the `(provider, provider_ref)` no-op replay behaviour the docs promise |
| O-7 | Medium | **No load test.** `08-scale.md` reasons well about 266 fixes/s but no number is measured; PgBouncer sizing and the H3 candidate-set query are both untested under contention | One afternoon of k6 against the location and approval paths before the 500-runner step |
| O-8 | Medium | **Mobile app hardening is documented only.** Certificate pinning, Keystore/Keychain handling, biometric payout gating and attestation are all prose | Attestation gates a real anti-fraud control (§7.5); the others are table stakes for a money app |
| O-9 | Medium | **`kyc_case` field encryption has no implementation, format or key rotation path** | `KYC_ENCRYPTION_KEY_ID` was added so the envelope carries a key id from day one; a 7-year retention with an unversioned envelope cannot be rotated retrospectively |
| O-10 | Low | Break-glass DB access, dependency scanning, container scanning, DPIA and the ODPC registration are all named in `07-security.md` and none exist yet | The first three are pipeline work; the last two are legal-ops work with lead times measured in weeks |

## 10.4 Architecture: what the panel would keep, change, and stop

**Keep.** The atomic money module. The outbox. The frozen fee split in `errand_fee`. The
conditional one-line UPDATE for assignment — it is the correct concurrency control and it is
cheaper and more obviously right than any lock. Checkpoint-based ETA rather than map routing.
The derived X25519 link: the platform genuinely cannot forge a fix, and the honesty of §7.8
about what it does *not* protect is the kind of documentation the panel rarely sees.

**Change.** Seven services on Redis Streams with a per-service outbox is more operational
surface than a pilot team can carry, and `08-scale.md`'s own numbers make the argument: the
money path is 0.7 writes/s. The split is justified for `location` and nothing else. The panel
recommends shipping the pilot as two deployables — the API-plus-money monolith and the
location service — with the module boundaries kept exactly as documented so the split can
happen later without a rewrite. Boundaries are cheap; deployables are not.

**Stop.** Do not add a second Postgres cluster, a service mesh, or per-service databases
before the load test in O-7 says a specific component needs one. §7.8 already accepts that
one cluster is one blast radius; that acceptance is sound at pilot scale and should be
revisited with data, not with architecture diagrams.

## 10.5 Operability additions the panel considers mandatory

**Reconciliation, extended.** The nightly job as specified checks issuer balances, the Daraja
statement, and that the whole ledger sums to zero. Add, because P-1 passed all three:

- every ledger account's balance has its expected sign (`escrow_hold` never positive for a
  requester with no funded errands, `reimbursement_due` zero for every settled errand,
  `errand_card_float` zero for every closed card);
- per errand: `sum(escrow postings) = funded − released − refunded`, asserted independently of
  the `escrow` mirror table, which is a cache and can be wrong;
- `platform_fee` for the day equals `sum(errand_fee)` for errands settled that day;
- every `tranche` with `status = 'loaded'` has exactly one successful `card_attempt`, and
  every card's `loaded_cents` equals the sum of its loaded tranches.

Each assertion pages rather than logs. The property that makes these worth writing: they are
statements about *meaning*, and a balanced-but-wrong group violates meaning while satisfying
arithmetic.

**Four alerts.** Outbox oldest-pending age (alert on age, not count — three rows stuck for an
hour is an incident, five thousand rows one second old is a busy Saturday); ladder escalation
rate per hour against its trailing week; card-load p99 including issuer time; approval
transaction serialization-failure rate, which is the early warning that SERIALIZABLE contention
has become a product problem.

**Two runbooks, written before they are needed.** A stranded card (P-4's residue: issuer
holds value, ledger does not know) and a parked outbox row that is an `errand.settled`. Both
are money-touching manual interventions; both need a named owner and an audit trail.

## 10.6 Entering global markets

The panel's central point: nothing below is a port of the current system. Each item is a
decision that has to be made *before* the first row of foreign data exists, because every one
of them is cheap now and a migration later.

### 10.6.1 Money is single-currency by construction

`Cents` carries no currency tag, and every cap, floor, fee and limit downstream assumes a
two-decimal minor unit. That is correct for Kenya and wrong for a second market. Required
before the first non-KES errand:

- **A currency-tagged money type.** `Money = { amount: bigint, currency: Currency }`, with the
  minor-unit exponent taken from a table, not assumed — JPY and KRW have no minor unit, KWD,
  BHD, OMR and TND have three, and a system that hardcodes two will be wrong by a factor of
  ten or a thousand in those markets. Arithmetic between different currencies must be a type
  error, not a runtime check.
- **`bigint`, not `number`.** `Number.isSafeInteger` holds to about 90 trillion minor units,
  which is fine for KES and not for IDR or VND at volume. Change it while the ledger is small.
- **Currency on every ledger row**, with a constraint that a posting group is single-currency.
  FX belongs in an explicit conversion group with the rate, the source and the timestamp
  recorded — never an implicit conversion inside a business posting.
- **One ledger per currency, or a currency dimension on every balance assertion.** A
  cross-currency "sums to zero" check is meaningless.
- **Rounding policy stated once and tested**: fee splits, FX conversion and payout minimums
  each need a documented direction, and the sum-preserving `split()` already in
  `money.ts` is the right primitive to build them on.

### 10.6.2 Payment rails are the market, not a detail

M-Pesa is not a payment method, it is the reason the Kenyan product works. In most markets
there is no equivalent, and the assumptions it carries — instant, phone-number-addressed,
push-confirmed, near-universal — are all local.

- **A rail port with capability flags**, not a driver interface: does the rail support push
  confirmation, is settlement instant or T+N, can it pay out to an identifier the user
  already has, what is the chargeback window. The card ladder and the escrow release timings
  both depend on these answers, and a rail with a 120-day chargeback window changes the
  escrow model rather than the adapter.
- **Chargebacks do not exist in the current design.** M-Pesa has no consumer-initiated
  reversal; cards do. Entering any card-first market means a dispute can arrive months after
  settlement, against money already paid to a runner. That is a new ledger account, a reserve
  policy, and a product decision about who bears the loss. It is the single largest financial
  model change in this list.
- **Payout rails are usually the harder half.** Runner cash-out to a bank account with an
  IBAN, a routing number or a local scheme is slower, costlier and more regulated than B2C to
  a phone number. The KSh 100 minimum payout is a KES-specific product decision that will not
  survive a market where a payout costs a fixed fee in euros.
- **The pooled-card fallback becomes more attractive abroad**, because per-card issuer fees
  scale with market count and negotiating them repeats per issuer. Keep the fallback live.

### 10.6.3 Licensing is the gate, not the code

Holding other people's money in escrow and paying it out is a regulated activity almost
everywhere, under different names and thresholds. The panel is not offering legal advice, and
the engineering position is this: **treat a licence as a hard dependency with a lead time
measured in quarters, not as a compliance task that runs in parallel with a launch.** What
engineering must supply is the same list in every jurisdiction — segregation of client funds
from operating funds, provable at any instant; a safeguarding account the ledger maps to
one-to-one; transaction reporting in the regulator's format; and an audit trail that survives
the retention period. The current ledger can support all of that; the current schema does not
distinguish client money from platform money, and it should before it holds any.

Two market-shaped consequences worth naming early: PCI scope stays SAQ-A only while nobody
touches a PAN (§7.8 says this and it is right — the moment a card form appears in the app,
that section and the audit scope both change); and card-first markets with strong customer
authentication requirements make the payment step an interactive flow, not a server-to-server
call, which affects the funding UX rather than the ledger.

### 10.6.4 Data protection multiplies rather than transfers

The Kenya DPA 2019 work in §7.6 is genuinely good preparation, and its structure — a named
DPO, residency, a job-enforced retention schedule, separate location consent — is the same
structure most regimes want. What does not transfer is the assumption of a single regime.

- **Residency becomes per-market.** `af-south-1` for Kenyan data is a commitment already
  made; a second market may require its own region, and a third may prohibit the transfer
  that a single global ops console implies. Design the ops console for *federated* access to
  regional data now, or accept rebuilding it later.
- **Cross-border transfer needs a stated legal basis per corridor**, and the engineering
  artefact that follows is a data-flow inventory that is accurate — including logs, error
  reporting, analytics and any support tooling. The Sentry and OTel scrubbers in §7.6 are the
  right instinct and need to be treated as a tested control, not a configuration.
- **Subject rights get harder, not different.** Erasure that pseudonymises `account` while
  retaining ledger rows is the correct answer and needs to be written down in each market's
  privacy notice, as §7.6 already does for Kenya.
- **Location data is the highest-risk category in almost every regime.** The 30-day point
  retention, the res-9 coarsening and the revocable consent are stronger than most
  marketplaces run and are worth keeping as a global floor rather than a Kenyan maximum. A
  DPIA per market is the mechanism; the current design will survive one.

### 10.6.5 Identity, sanctions and fraud stop being a KYC tier

Tier 3 as "national ID, conduct certificate, next of kin" is a Kenyan construct. Abroad the
same product need meets different documents, different verification vendors and different
legal minimums.

- **Abstract the tier from its evidence.** Tiers stay (they gate entitlements); what proves a
  tier becomes per-market configuration, with the document types, the vendor and the
  acceptable-failure policy all market-scoped.
- **Sanctions and PEP screening at onboarding and on a recurring basis** is a requirement the
  current system has no concept of, and it applies to both sides of the marketplace once money
  moves internationally. It needs a decision path for a hit, because a false positive that
  silently suspends a runner is a livelihood.
- **Transaction monitoring** — the velocity limits in §7.3 are a good fraud control and are
  not an AML programme. The difference is reporting obligations and case management.
- **Fraud patterns are local.** Collusion between a requester and runner to launder value
  through a fake errand is the obvious one, and it is cheaper to detect in the graph
  (`relationship`) than at the transaction. The data is already there.

### 10.6.6 Labour classification is an existential product risk

The runner is central to the product and their employment status is contested in many
jurisdictions, with a direction of travel toward reclassification. Engineering cannot decide
this, but two engineering choices materially affect exposure: how much the platform *directs*
the work (the assignment mode, the on-time bonus, whether the runner can decline freely) and
how much of the runner's activity is monitored. Both are now product knobs in config rather
than assumptions in code, which is the right place for them. The panel recommends the market
configuration explicitly carry a "direction of work" profile, so that entering a market with
strict rules is a configuration decision with a named owner rather than a rediscovery.

### 10.6.7 Localisation is more than translation

`en`/`sw` in `formatKes` is the shape of the problem, not the extent of it. Currency display,
number and date formats, name ordering, address formats that are not "estate, road, landmark",
phone number validation beyond `+254`, timezone handling for errand windows, and right-to-left
layout for Arabic or Hebrew markets — RTL is the one that is genuinely expensive to retrofit
in the mobile UI, and cheap to accommodate while the component set is small. SMS sender IDs,
alphanumeric-sender rules and push provider availability are per-market too, and the
`AT_SENDER_ID` default is a Kenyan artefact.

Two content items the panel flags because they are usually missed: the emergency number is
hardcoded to 999 in the SOS flow (§7.2), which is wrong in most countries and is a safety
feature; and market-specific trust-and-safety escalation paths need local hours, local
language and local law enforcement contacts, which is staffing, not code.

### 10.6.8 Infrastructure and the operating model

- **Multi-region, not global-region.** The current design is one cluster in one region, which
  §7.8 accepts honestly. For a second market the panel favours a **cell per market** —
  regional database, regional API, regional workers, shared build pipeline and shared code —
  over a single global cluster with regional replicas. It matches residency requirements, it
  bounds the blast radius, and it lets one market's incident be one market's incident. The
  cost is that anything cross-market (a global ops console, aggregate analytics) becomes a
  federation problem, which is the trade the panel would take.
- **The id space is ready** (UUIDs), the ledger is not (no market or currency dimension), and
  the H3 location model travels well.
- **Follow-the-sun on-call before the second market opens.** A Nairobi-hours team supporting a
  market eight time zones away is an availability decision disguised as a hiring decision.
- **Cost per market has a floor** — issuer fees, a licence, a DPO or representative, local
  support hours, a KYC vendor. The panel's advice is to compute that floor before choosing the
  second market, because it is usually what makes the choice, not the size of the addressable
  market.

## 10.7 Sequence

The order matters more than the contents; each phase's gate is what makes the next phase
survivable.

**Phase 0 — before the pilot.** O-1 and O-2: a pipeline that runs the RLS suite, the secret
scan, the config-refusal test and the header snapshot on every commit. The extended
reconciliation assertions (§10.5). The four alerts. The Daraja callback handler (O-6). The
Idempotency-Key store (O-5). *Gate: the cross-tenant suite is green against a real database,
and a deliberately broken posting group fails the nightly job in staging.*

**Phase 1 — pilot, 50 runners.** Watch the ladder escalation rate and the approval
serialization-failure rate; both are product signals disguised as technical metrics. Mobile
hardening (O-8) and the KYC encryption envelope (O-9) land here. *Gate: one full week with no
manual money intervention.*

**Phase 2 — national, 500 runners.** The load test (O-7) before, not after. Break-glass
access with a pager hook. Attestation for the GPS spoofing layer. *Gate: measured headroom at
3× observed peak on the location and approval paths.*

**Phase 3 — first foreign market.** Currency-tagged money and the ledger currency dimension
(§10.6.1) land **before** any foreign row exists. The rail port and the chargeback model.
Market-scoped KYC. A cell for the new market. *Gate: the Kenyan cell and the new cell run the
same build with no market-specific branches in domain code.*

**Phase 4 — multi-market operations.** Federated ops console, per-corridor transfer bases,
sanctions screening, follow-the-sun on-call.

## 10.8 What the panel explicitly does not recommend

- **Do not rewrite the money module into services** to match the seven-service diagram. Its
  atomicity is the reason the approval path is correct.
- **Do not adopt an event-sourced ledger.** The double-entry ledger with an append-only
  posting table already gives the audit properties, and the failures found in this review were
  arithmetic and durability, not modelling.
- **Do not build a global schema now.** Add the currency dimension (cheap, irreversible if
  skipped) and defer every other multi-market abstraction until a second market is chosen —
  abstractions built for an unknown market are almost always wrong about it.
- **Do not treat `07-security.md` as a compliance document.** It is an unusually good
  engineering document. The gap this review found was never in the thinking; it was that
  nothing in the pipeline made the thinking true.
