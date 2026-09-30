# Chat

_Started 2026-09-29 19:40 UTC_

---

## User

Continuing from "System security audit checklist".

## Assistant

We were building Side Qwest for production launch — a gig-errand platform in Kenya with dual-mode funding, multi-rail payment (M-Pesa, card, wallet, bank), real-time location handshakes, and event-driven services over Redis Streams.

We locked in a seven-service architecture, atomic money module with SERIALIZABLE transactions, PostGIS + H3 for location, X25519 + HMAC for handshakes, and 12% fees split 50/50 at settlement.

After a full security audit, we found four live vulnerabilities (no RLS, stall IDOR, decline-offer unauthorized, location scraper) and fixed them with per-role RLS bound via actor-context, rate limiting (17 Redis buckets), XSS hardening at five points, and gated endpoints. A panel review then found three worse defects in the money code: settlement debiting escrow twice, a `&&` operator that marked all pending reimbursements as paid, and an at-most-once outbox. All three are corrected; outbox rewritten with claim-lease-dispatch.

We then added a currency type that carries exponent and code as data (staying 2 decimals for KES but scaling to multi-currency by country), built a Phase 0 pipeline (CI workflow, migration gates, reconciliation jobs), and added cross-platform parity for Android and iOS using the Organic design system — brand shared, chrome native, with adaptive.ts as the single branching point.

Current state: all code and security controls in place; CI/IaC/migration gates functional; currency type live; mobile parity documented. Doc-integrity issues fixed (broken cross-references resolved, README index updated).

Open: five external specs not fixable in-repo (Daraja source-IP verification, Play Integrity, break-glass DB access, KYC encryption envelope, assignment race pen test), four design decisions you flagged (tablet/landscape, min Android version, low-end targets, dark mode support).

Project files: `03c-rls.sql`, `03d-outbox-hardening.sql`, `03e-currency.sql`, `09-appsec-audit.md`, `10-panel-review.md`, `11-cross-platform.md`, `code/ci/ci.yml`, `code/domain/money/currency.ts`, `code/api/plugins/actor-context.ts`, `code/api/plugins/rate-limit.ts`, `code/mobile/platform/adaptive.ts`.

