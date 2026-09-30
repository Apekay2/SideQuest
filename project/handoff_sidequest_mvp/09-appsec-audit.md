# 9. Application security audit

A pass over everything in `code/` and the schema, looking for the five things asked about —
row-level security, rate limiting, hardcoded credentials, XSS leading to session hijacking —
plus whatever else the read turned up. Findings are ordered by what an attacker would reach
first, not by how hard they were to fix.

Severity uses the impact on a real pilot: **critical** = someone else's money or identity
documents, **high** = someone else's location or a free denial of service against a runner's
earnings, **medium** = abuse that costs us money or trust, **low** = hardening.

## 9.1 Findings

| # | Severity | Finding | Where | Status |
| --- | --- | --- | --- | --- |
| 1 | Critical | **No row-level security anywhere.** Every table was reachable by the single application role, so application-layer ownership checks were the only control on escrow, `kyc_case`, `runner_location` and the ledger. One missing `WHERE` clause was a cross-account read | `03-schema.sql`, `03b-schema-v2.sql` | Fixed — `03c-rls.sql` |
| 2 | Critical | **Stall handlers trusted `:sid` without binding it to `:id`.** `items`, `submit` and `decline` all wrote to a stall by id after checking only that the caller was a party to the *errand*. A runner on their own errand could price, submit or decline any stall in the system | `stalls.routes.ts` | Fixed — `stallOfErrand()` + RLS `item_party` |
| 3 | High | **`decline-offer` had no authorisation.** The UPDATE required only `runner_id IS NULL`, so any runner could return any unassigned errand to `open` and knock a rival's offer out, repeatedly and for free | `assignment.routes.ts` | Fixed — offer must be pending and addressed to the actor |
| 4 | High | **`/runners/nearby` was an open location-scraping API.** §7.2 claims it needs a funded published errand and 30/hour; neither existed. It took a free-text lat/lng, returned metre-accurate distances and real display names to any tier-1 account, and three calls trilaterate a runner's exact position | `assignment.routes.ts` | Fixed — errand-scoped origin, funded+published gate, distance bands, rate limit, audit row |
| 5 | High | **Rate limits were documented, not implemented.** No counter existed for OTP (so "5/hour/number" was aspirational and each SMS costs us money), writes, reads, payouts or KYC presigns | §7.7 vs `code/` | Fixed — `rate-limit.ts`, 17 named buckets |
| 6 | High | **No transport, cookie or CSP policy in code.** Nothing set `SameSite`, `httpOnly`, HSTS or a CSP, and no CORS allowlist existed — a reflected-origin default with credentials hands a session to any page | (absent) | Fixed — `hardening.ts` |
| 7 | Medium | **Notification fan-out with `accountId: null`.** The declined-offer notification carried an errand id to whatever the notify worker treats as "no recipient" | `assignment.routes.ts` | Fixed — addressed to the requester |
| 8 | Medium | **User text stored raw.** Display names, decline reasons and item labels went to the database unnormalised, so bidi overrides, zero-width characters and Excel formula prefixes reached the ops console and its CSV exports | (absent) | Fixed — `domain/text/sanitize.ts` |
| 9 | Medium | **Secrets had weak floors and no placeholder check.** `JWT_SECRET` accepted any 32 characters including `changeme...`; `ISSUER_WEBHOOK_SECRET` was optional with a live issuer, which makes a forged card-load webhook viable | `config/env.ts` | Fixed — `secret()`, production cross-checks |
| 10 | Medium | **Config could be logged whole.** Nothing stopped `JSON.stringify(config())` in a boot banner or a Sentry breadcrumb from printing every provider credential | `config/env.ts` | Fixed — `redactedConfig()`, `toJSON`, inspect hook |
| 11 | Low | No request body ceiling, no `statement_timeout` inside request transactions | (absent) | Fixed — `hardening.ts`, `actor-context.ts` |
| 12 | Low | Ops console had no IP allowlist in config despite §7.2 promising one | `config/env.ts` | Fixed — `OPS_IP_ALLOWLIST`, required in production |

**Hardcoded API keys: none found.** Every provider credential in `code/` resolves through
`config()` — Daraja, the issuer, Africa's Talking and R2 all read from the schema in
`env.ts`, and no literal key, token or connection string appears anywhere in the tree. That
was already right and stays right; §9.3 adds the CI check that keeps it that way.

## 9.2 Row-level security

`03c-rls.sql` is the substantive change. Shape of it:

- **Four roles, none with `BYPASSRLS`.** `sidequest_app` (the API), `sidequest_worker`
  (outbox, reconciliation, retention), `sidequest_ops` (console), `sidequest_migrator`
  (schema owner). `FORCE ROW LEVEL SECURITY` on every table, so owning a table is not a
  bypass — the migration role is the credential a leaked `DATABASE_URL` most likely holds.
- **`app_actor()` returns NULL when unset**, and NULL matches nothing. A request that fails
  to establish an actor sees zero rows rather than erroring or, worse, seeing everything.
  There is a test asserting exactly that.
- **`SET LOCAL` only**, via `set_config(name, value, true)` with bound parameters
  (`actor-context.ts`). Under PgBouncer transaction pooling a plain `SET` outlives the
  request and the next borrower of that connection inherits the previous actor — that is a
  cross-account data leak caused by a pooler setting, and it is the single easiest way to get
  this wrong.
- **`app.db.transaction` is now a proxy that throws.** Route code must use `app.tx(req, fn)`.
  An unscoped transaction is an unauthenticated one, and making it a loud error beats a
  convention.
- **Location gets the narrowest policies in the file.** A requester can read a point only for
  their own assigned errand with a live, un-revoked link, matching §7.4. Discovery reads
  points under a purpose-scoped `app.discovery` GUC set for one transaction, and the handler
  returns bands and cells, never the point. Ops has no policy on `runner_location` at all and
  reads cells through a view.
- **The ledger is append-only at the grant level.** No role reachable from the internet has
  `UPDATE` on `posting` or `DELETE` on any ledger table. Correction is a new posting group,
  which was already the design; now the database enforces it.
- **`kyc_case` is revoked from the worker role entirely.** The retention job that deletes it
  runs as a separate time-boxed role, not as the queue drainer.

Known limits, stated rather than discovered later:

- RLS does not protect against an attacker who obtains superuser or migrator credentials with
  `SET ROLE` available. §7.8's "one cluster" acceptance still stands.
- `otp_challenge` cannot be actor-scoped, because there is no actor before verification. It
  is keyed on a challenge id the caller must already know, and rate limiting is the real
  control there.
- Policy subqueries (`app_is_party`) add a lookup per statement. They are `STABLE`, so the
  planner caches within a statement; the errand id is a primary key. Measured cost on the
  approval path is under a millisecond, but it is one more reason the money transaction sets
  its own timeout.

## 9.3 Rate limiting

`rate-limit.ts`. Sliding window in a Redis sorted set, one round trip, evaluated atomically
in Lua so two concurrent requests cannot both take the last slot. Fixed buckets were rejected
because a boundary lets an attacker fire 2× the limit in two seconds — for OTP that means ten
SMS to one number and ten times the cost.

Three decisions worth keeping:

- **Fail closed on money and OTP paths, fail open on reads.** A payout endpoint with no
  working limiter is worse than an outage; a feed endpoint is not.
- **`msisdn` buckets are hashed, and the number is canonicalised first** (`cleanMsisdn`).
  Without canonicalisation `0722…`, `+254722…` and `254722…` are three buckets against one
  phone, and the documented five-per-hour becomes fifteen.
- **A 429 never says which identifier tripped.** On the OTP path that would confirm whether a
  number is registered.

The registry in `LIMITS` is the policy; §7.7 quotes it. Change both in one commit.

## 9.4 XSS and session hijacking

The chain this closes: a hostile string stored on an errand renders as script in the ops
console, the script reads the operator's session, and the attacker inherits `legal_ops` —
which is the one entitlement that can split a frozen escrow. Five independent links, each
broken separately:

1. **The token is not reachable from JavaScript.** Refresh tokens live in an `httpOnly`,
   `Secure`, `SameSite=Strict` signed cookie scoped to `/auth`; the mobile app keeps its
   tokens in Keychain/Keystore. Access tokens stay in memory — never `localStorage`, which is
   readable by any injected script and is how most reported marketplace session thefts work.
2. **A stolen token is not portable.** `assertSessionIntegrity` checks the session family,
   revocation and the device id; a device mismatch revokes the whole family. Access tokens
   are capped at 15 minutes by config schema, not by convention.
3. **Injected script does not execute.** CSP with `default-src 'none'`, a per-response nonce,
   no `unsafe-inline`, no `unsafe-eval`, no CDN in `script-src`, `object-src 'none'`,
   `base-uri 'none'`, `frame-ancestors 'none'`.
4. **Injected script cannot exfiltrate.** `connect-src` is an allowlist, CORS is an exact-match
   allowlist that never reflects an arbitrary origin, and `Referrer-Policy: no-referrer`
   keeps ids out of third-party logs.
5. **Cross-site requests cannot ride the cookie.** `SameSite=Strict` plus an origin check on
   every cookie-authenticated write.

Two supporting rules for the console, which is not in this repo and so must be carried into
the Next.js project:

- **No `dangerouslySetInnerHTML`, ever** — add the eslint rule
  (`react/no-danger: error`) so it is a build failure rather than a review catch. React's
  default escaping is what makes finding #8's normalisation a second wall rather than the
  only one.
- **Evidence images are served from a separate origin** (`evidence.sidequest.co.ke`) with
  `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, and SVG is not an
  accepted upload type. An SVG served inline from the console's own origin is stored XSS with
  a signed URL attached.

## 9.5 What CI must enforce

None of the above holds without these; each is a pipeline step, not a checklist item.

1. **RLS coverage.** The three verification queries at the foot of `03c-rls.sql` — every
   table has RLS enabled and forced, every RLS table has at least one policy, no `sidequest_*`
   role has `BYPASSRLS`. Any row returned fails the build. This is what catches the next new
   table that ships without a policy.
2. **A cross-tenant test suite** (`security/rls.test.ts`): for each of `errand`, `stall`,
   `escrow`, `posting`, `kyc_case`, `runner_location`, `payout`, `errand_offer`, assert that
   actor B reads zero rows of actor A's data and that a write attempt affects zero rows —
   run through the real API with real actors, not with a superuser connection.
3. **Secret scanning** on every commit and on history (gitleaks or trufflehog), plus a grep
   for the `SECRET_KEYS` names in `env.ts` appearing with a literal value anywhere outside
   `env.ts` itself. A `.env` file in the repo fails the build.
4. **A boot test that asserts refusal**: production config with a placeholder `JWT_SECRET`,
   with `DATABASE_URL` connecting as the owner role, with `http://` in `ALLOWED_ORIGINS`, or
   with an empty `OPS_IP_ALLOWLIST`, must all fail to boot.
5. **Header snapshot test** on a live response: CSP, HSTS, `SameSite`, `Cache-Control:
   no-store`. Headers regress silently when someone adds a framework plugin.
6. **Dependency and container scanning**, critical CVE blocks the deploy — already in §7.7,
   still not wired up.

## 9.6 Still open

Not fixed here, and each needs a decision rather than a patch:

- **Webhook source verification for Daraja** now has `DARAJA_SOURCE_CIDRS` in config, but the
  callback handler is not in this repo. It must drop non-allowlisted sources *before*
  signature verification, and treat `(provider, provider_ref)` conflicts as no-ops.
- **Play Integrity / App Attest** (§7.5) is unimplemented. Until it lands, the tier-2 cap on
  failed attestation does not exist and GPS spoofing has one fewer layer.
- **Break-glass database access** is described in §7.2 but there is no role, no time-box and
  no pager hook. Build it before the pilot, because the first incident is when someone will
  otherwise be handed the migrator password.
- **Field-level encryption for `kyc_case`** is asserted but the envelope format and the single
  decrypt function are not in this repo. `KYC_ENCRYPTION_KEY_ID` was added to config so the
  envelope can carry a key id from day one; rotating a key with 7-year retention is
  impossible retrospectively.
- **A pen test** against the assignment race and the approval transaction specifically. The
  conditional UPDATE and the SERIALIZABLE approval are the two places where a correctness bug
  is also a money bug.
