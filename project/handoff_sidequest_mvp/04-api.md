# 4. API

Base `https://api.sidequest.co.ke/v1`. JSON only. All money fields are integer KSh cents named
`*_cents`. All timestamps ISO 8601 UTC.

## Conventions

**Auth.** `Authorization: Bearer <jwt>`, 15-minute access token. Claims:
`sub`, `role`, `tier`, `ent[]` (entitlement strings), `sid`. Refresh via `POST /auth/refresh`
with a rotating refresh token in an httpOnly cookie (console) or secure store (mobile).

**Idempotency.** Every `POST` that moves money or creates a resource requires an
`Idempotency-Key` header (UUID v4). The stored response is replayed for 24 hours.

**Errors** are RFC 7807 `application/problem+json`:

```json
{ "type": "https://api.sidequest.co.ke/errors/spend-cap-exceeded",
  "title": "Stall total exceeds the remaining spend cap",
  "status": 409,
  "detail": "Stall total 84000 exceeds remaining cap 61500",
  "instance": "/v1/errands/8f2…/stalls/3a1…/approve",
  "code": "SPEND_CAP_EXCEEDED" }
```

Codes the clients branch on: `OTP_INVALID`, `OTP_THROTTLED`, `TIER_REQUIRED`,
`ERRAND_STATE_INVALID`, `SPEND_CAP_EXCEEDED`, `BID_CLOSED`, `RETAKE_EXHAUSTED`,
`CARD_DECLINED`, `INSUFFICIENT_ESCROW`, `PAYOUT_FAILED`, `IDEMPOTENCY_CONFLICT`.

**Pagination** is cursor based: `?limit=20&cursor=<opaque>` → `{ data, next_cursor }`.

**Rate limits** return `429` with `Retry-After`.

---

## Auth

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST` | `/auth/otp` | none | `{msisdn}` → `{challenge_id, expires_at}`. 5/hour/number. |
| `POST` | `/auth/verify` | none | `{challenge_id, code}` → `{access, refresh, account}`. 3 attempts. |
| `POST` | `/auth/refresh` | refresh | Rotates. Reuse of a spent refresh revokes the whole session family. |
| `POST` | `/auth/logout` | bearer | Revokes current session. |
| `GET` | `/me` | bearer | Account, tier, entitlements, language. |
| `PATCH` | `/me` | bearer | `{display_name?, language?}`. |

## KYC

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST` | `/kyc/cases` | bearer | `{target_tier}` → case with presign slots. |
| `POST` | `/kyc/cases/:id/documents` | bearer | `{slot, content_type}` → `{upload_url, object_key}`, 5-min presign. Slots: `id_front`, `id_back`, `selfie`, `conduct_cert`. |
| `POST` | `/kyc/cases/:id/submit` | bearer | Tier 3 requires `conduct_cert`, `next_of_kin`, `movement_consent: true`. → `status: submitted`. |
| `GET` | `/kyc/cases/mine` | bearer | Latest case + rejection reason. |

Tier gates enforced at the gateway: tier 1 to post an errand, tier 2 to bid, **tier 3 to be
awarded** an errand carrying a card.

## Errands — requester

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST` | `/errands` | tier 1 | Body below. Creates `draft`. |
| `POST` | `/errands/:id/publish` | tier 1 | Requires funded escrow ≥ `spend_cap + max_fee`. Sets `open`, schedules auction close. |
| `GET` | `/errands` | bearer | `?role=requester|runner&status=…`. |
| `GET` | `/errands/:id` | party | Full aggregate: stalls, items, tranches, evidence, runner (post-award only). |
| `POST` | `/errands/:id/cancel` | requester | Pre-award: full refund. Post-award: runner keeps a cancellation fee equal to the lesser of the bid fee and KSh 150. |
| `GET` | `/errands/:id/bids` | requester | **Sealed until close.** Before `auction_closes_at` returns `{count}` only. |
| `POST` | `/errands/:id/award` | requester | `{bid_id}`. Single-winner election; second caller gets `409 BID_CLOSED`. |
| `POST` | `/errands/:id/invite` | requester | `{runner_id}`. Direct offer to a past runner, skips the auction. Requires an unblocked `relationship` row. |

`POST /errands` body:

```jsonc
{
  "kind": "market_run",
  "title": "Wakulima market — Tuesday veg",
  "notes": "Sukuma from the third row, she knows me",
  "dropoff": { "lat": -1.2833, "lng": 36.8219, "label": "Kilimani, Wood Ave 12" },
  "spend_cap_cents": 350000,           // KSh 3,500
  "deadline_at": "2026-09-02T15:00:00Z",
  "bonus_cents": 5000,                 // optional on-time bonus, KSh 50
  "auction_minutes": 15,
  "stalls": [
    { "seq": 1, "name": "Mama Njeri — vegetables", "till_number": "174379",
      "items": [ { "label": "Sukuma wiki", "qty": 3, "unit": "bunch" },
                 { "label": "Tomatoes", "qty": 2, "unit": "kg" } ] },
    { "seq": 2, "name": "Butchery — Ndege",
      "items": [ { "label": "Beef, boneless", "qty": 1.5, "unit": "kg" } ] }
  ]
}
```

## Errands — runner

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/feed` | tier 2 | Open errands within radius, ranked. Never exposes other bids. |
| `POST` | `/errands/:id/bids` | tier 2 | `{fee_cents, eta_minutes, note?}`. One per runner; re-POST updates until close. |
| `DELETE` | `/errands/:id/bids/mine` | tier 2 | Withdraw before close. |
| `POST` | `/errands/:id/start` | runner | `awarded` → `en_route`. Starts the timer. |
| `POST` | `/errands/:id/arrive` | runner | `en_route` → `shopping`. |
| `GET` | `/batches/eligible` | tier 3 | Errands batchable with the current one: same market, overlapping window. Each keeps its own card. |
| `POST` | `/batches` | tier 3 | `{errand_ids[], planned_for}`. |

## Stalls, evidence and approval — the money path

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST` | `/errands/:id/stalls/:sid/items` | runner | `{items:[{id, price_cents}]}` — runner enters prices found at the stall. Recomputes `total_cents`. |
| `POST` | `/errands/:id/stalls/:sid/evidence` | runner | `{kind, content_type}` → presigned PUT. `attempt` increments; a 3rd attempt returns `409 RETAKE_EXHAUSTED` and raises a requester decision. |
| `POST` | `/errands/:id/stalls/:sid/submit` | runner | Marks `photographed`, notifies the requester. |
| `POST` | `/errands/:id/stalls/:sid/approve` | requester | **Returns `202`.** Holds escrow, writes the tranche, enqueues `card.load`. `409 SPEND_CAP_EXCEEDED` if over cap. |
| `POST` | `/errands/:id/stalls/:sid/decline` | requester | `{reason}` → stall `declined`, no tranche, runner told to skip. |
| `POST` | `/errands/:id/stalls/:sid/substitute` | requester | `{line_item_id, label, qty, unit, price_cents}` → new item linked by `substituted_for`. |
| `GET` | `/errands/:id/tranches` | party | Tranche + attempt trace. This is what the runner's "spend now" card polls. |
| `POST` | `/errands/:id/reimbursement/confirm` | requester | Ladder rung 3. `{tranche_id, accept}`. 5-minute window, then auto-escalates. |
| `POST` | `/errands/:id/handover` | runner | `{qr_token}` scanned from the requester's screen. → `settled`, enqueues settlement + payout. |
| `GET` | `/errands/:id/handover-token` | requester | Rotating 60-second QR token, server-issued. The runner scans it to release the task and write the logs back. Unchanged by the link handshake. |
| `POST` | `/errands/:id/link` | party | Publish this device's X25519 public key; returns the counterpart's once available. |
| `POST` | `/errands/:id/link/ack` | party | `{link_hash}`. The handshake proof. Location sharing stays refused until both sides post the same hash. |
| `DELETE` | `/errands/:id/link` | party | Revoke early. Automatic at settlement; both devices wipe the derived secret. |
| `POST` | `/location` | runner | `{lat, lng, seq, hmac_tag, detail_enc?, recorded_at}` or a batch of queued fixes in `seq` order. Requires tier 3, `movement_consent`, and an active link. `403 CONSENT_REQUIRED` or `409 LINK_NOT_ESTABLISHED` otherwise. |
| `GET` | `/errands/:id/location` | requester | Last verified fix, its age, and the link state (`linked_stale` when the runner is offline — never `unknown`). |
| `GET` | `/feed` | tier 2 | Radius is `ST_DWithin` against `errand.pickup`. H3 cells never decide visibility. |

Approval response:

```jsonc
{ "tranche": { "id": "…", "seq": 2, "amount_cents": 84000, "status": "pending" },
  "remaining_cap_cents": 266000,
  "poll_after_ms": 1500 }
```

## Wallet, payouts, chat, disputes

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/wallet` | bearer | Balance, escrow held per errand, recent postings. |
| `POST` | `/wallet/topup` | bearer | `{amount_cents}` → Daraja STK push. Confirmed by webhook, never by the client. |
| `POST` | `/wallet/withdraw` | bearer | `{amount_cents}` → B2C. Requester refunds only. |
| `GET` | `/earnings` | runner | Fees, bonuses, reimbursements owed, next payout. |
| `POST` | `/payouts` | runner | `{amount_cents}` cash-out to the registered MSISDN. Min KSh 100, 1/day free. |
| `GET` | `/errands/:id/messages` | party | Cursor paginated. |
| `POST` | `/errands/:id/messages` | party | `{body}`. Closed 24h after settlement. |
| `POST` | `/errands/:id/sos` | party | Snapshots location + both identities, opens a case, returns the 999 dial intent. |
| `POST` | `/disputes` | party | `{errand_id, reason, detail}`. Pre-settlement filing freezes escrow. |
| `GET` | `/disputes/mine` | bearer | |

## Ops console (staff entitlement, IP-allowlisted)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/ops/kyc?status=submitted` | Review queue, oldest first. |
| `POST` | `/ops/kyc/:id/decide` | `{approve, tier?, reason?}`. Writes `audit_log`. |
| `GET` | `/ops/disputes?status=open` | Queue with age. |
| `GET` | `/ops/disputes/:id/evidence` | Evidence pack; each read writes an access audit row. |
| `POST` | `/ops/disputes/:id/rule` | `{outcome, requester_cents, runner_cents, rationale}`. Only path that splits a frozen escrow; requires `ent: legal_ops`. |
| `GET` | `/ops/errands/:id/trace` | Full money trace: postings, tranches, attempts, provider refs. |
| `POST` | `/ops/cards/:id/void` | Manual void. |

## Webhooks (inbound, signature-verified, always `200`)

| Path | Source |
| --- | --- |
| `POST /webhooks/daraja/stk` | Escrow funding confirmation |
| `POST /webhooks/daraja/b2c/result` | Payout and till-payment results |
| `POST /webhooks/daraja/timeout` | Queue timeouts |
| `POST /webhooks/issuer/authorization` | Card authorisation, capture, reversal |

Webhook handlers do one thing: verify the signature, insert into `mpesa_event` or
`card_attempt`, enqueue processing. They never contain business logic and they never fail the
sender — a `500` to Safaricom triggers a retry storm.

## Realtime

WebSocket at `/ws` authenticated with the access token. Server-push events, all also derivable
by polling so the client degrades gracefully on bad networks:

`bid.received` · `errand.awarded` · `stall.submitted` · `tranche.loaded` · `tranche.failed`
· `reimbursement.requested` · `message.new` · `errand.settled` · `payout.confirmed`
