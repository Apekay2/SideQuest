// packages/contracts/src/index.ts
// The API's only truth. Routes validate request bodies with these schemas; the mobile app and
// the console import the response types. A shape cannot drift between server and client
// because both read this file.
//
// Conventions (04-api.md): money is integer minor units in fields named *_cents; timestamps
// are ISO 8601 UTC strings; ids are UUIDs.

import { z } from 'zod';

const uuid = z.string().uuid();
const cents = z.number().int().nonnegative();
const positiveCents = z.number().int().positive();
const iso = z.string().datetime({ offset: true });

// ─────────────────────────────────────────────── shared enums

export const ErrandKind = z.enum(['market_run', 'queue_stand', 'document_drop', 'custom']);
export type ErrandKind = z.infer<typeof ErrandKind>;

export const ErrandStatus = z.enum([
  'draft', 'open', 'awaiting_funds', 'offered', 'awarded', 'en_route', 'shopping',
  'awaiting_approval', 'handover', 'settled', 'cancelled', 'disputed', 'expired',
]);
export type ErrandStatus = z.infer<typeof ErrandStatus>;

export const StallStatus = z.enum(['pending', 'photographed', 'approved', 'declined', 'substituted', 'skipped']);
export type StallStatus = z.infer<typeof StallStatus>;

export const TrancheStatusEnum = z.enum(['pending', 'loaded', 'failed', 'reversed']);
export const AssignmentMode = z.enum(['pick', 'open']);
export const Language = z.enum(['en', 'sw']);
export const Role = z.enum(['requester', 'runner']);

// ─────────────────────────────────────────────── auth

export const OtpRequest = z.object({ msisdn: z.string().min(9).max(16) });
export const OtpVerify = z.object({
  challenge_id: uuid,
  code: z.string().regex(/^\d{6}$/),
  device_id: z.string().min(8).max(128).optional(),
  role: Role.optional(),
  display_name: z.string().min(1).max(48).optional(),
  /** The ops console sets this: never create an account, and issue a session only to staff. */
  staff_only: z.boolean().optional(),
});
export const RefreshRequest = z.object({ refresh: z.string().min(20).max(200).optional() });
export const PatchMe = z.object({
  display_name: z.string().min(1).max(48).optional(),
  language: Language.optional(),
  role: Role.optional(),
}).refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export interface OtpChallenge { challenge_id: string; expires_at: string }
export interface Me {
  id: string;
  display_name: string;
  role: 'requester' | 'runner' | 'staff';
  verification_tier: 0 | 1 | 2 | 3;
  entitlements: string[];
  language: 'en' | 'sw';
  market: string;
}
export interface Session { access: string; refresh: string; expires_in: number; account: Me }

// ─────────────────────────────────────────────── KYC

export const KycSlot = z.enum(['id_front', 'id_back', 'selfie', 'conduct_cert']);
export const CreateKycCase = z.object({ target_tier: z.number().int().min(2).max(3) });
export const PresignDocument = z.object({
  slot: KycSlot,
  content_type: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
});
export const SubmitKyc = z.object({
  id_number: z.string().regex(/^\d{6,10}$/).optional(),
  next_of_kin: z.object({ name: z.string().min(1).max(48), msisdn: z.string().min(9).max(16) }).optional(),
  movement_consent: z.boolean().optional(),
});
export interface KycCase {
  id: string; target_tier: number; status: string; reject_reason: string | null;
  slots: Record<string, boolean>; created_at: string;
}
export interface Presigned { upload_url: string; object_key: string; expires_in: number; headers: Record<string, string> }

// ─────────────────────────────────────────────── errands

const Point = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  label: z.string().min(1).max(120),
});

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
    items: z.array(z.object({
      label: z.string().min(1).max(80),
      qty: z.number().positive().max(9999),
      unit: z.string().min(1).max(16),
    })).min(1).max(40),
  })).max(20).default([]),
});
export type CreateErrand = z.infer<typeof CreateErrand>;

export const FundErrand = z.object({
  rail: z.enum(['wallet', 'mpesa_stk']),
});

export const PlaceBid = z.object({
  fee_cents: positiveCents,
  eta_minutes: z.number().int().min(1).max(600),
  note: z.string().max(280).optional(),
});
export const AwardBid = z.object({ bid_id: uuid });
export const Offer = z.object({ runner_id: uuid, fee_cents: positiveCents });
export const Invite = z.object({ runner_id: uuid, fee_cents: positiveCents });
export const CancelErrand = z.object({ reason: z.string().max(280).optional() });

export const FeedQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius_m: z.coerce.number().int().min(200).max(10_000).default(3000),
});
export const NearbyQuery = z.object({
  errand_id: uuid,
  radius_m: z.coerce.number().int().min(200).max(10_000).default(3000),
});

export interface LineItem {
  id: string; label: string; qty: number; unit: string; price_cents: number | null;
  substituted_for_label: string | null; accepted: boolean | null;
}
export interface Stall {
  id: string; seq: number; name: string; till_number: string | null; status: StallStatus;
  total_cents: number; photo_url: string | null; evidence_attempts: number; items: LineItem[];
}
export interface Tranche {
  id: string; seq: number; stall_id: string; amount_cents: number;
  status: z.infer<typeof TrancheStatusEnum>;
  reimbursement_confirmed: boolean | null;
  attempts: { rung: string; result: string; code: string | null; at: string }[];
}
export interface Counterparty { id: string; display_name: string; verification_tier: number }
export interface ErrandSummary {
  id: string; kind: ErrandKind; status: ErrandStatus; title: string;
  spend_cap_cents: number; spent_cents: number; max_fee_cents: number; agreed_fee_cents: number | null;
  bonus_cents: number; deadline_at: string | null; created_at: string;
  stall_count: number; stalls_done: number; role: 'requester' | 'runner';
  /** The other party's display name, once there is one. */
  counterparty_name: string | null;
  /** Each stall's status in seq order: the live card draws one segment per stall. */
  stall_states: StallStatus[];
  eta_at: string | null;
}
export interface ErrandDetail extends ErrandSummary {
  notes: string | null;
  assignment_mode: 'pick' | 'open';
  funding_mode: 'upfront' | 'tranche';
  pickup: { lat: number; lng: number; label: string | null } | null;
  dropoff: { lat: number; lng: number; label: string };
  auction_closes_at: string | null;
  offered_to: string | null;
  requester: Counterparty;
  runner: Counterparty | null;
  stalls: Stall[];
  tranches: Tranche[];
  escrow: { funded_cents: number; held_cents: number; frozen: boolean } | null;
  fee: { requester_fee_cents: number; runner_fee_cents: number } | null;
  eta: { percent_complete: number; eta_at: string | null; confidence: 'high' | 'medium' | 'low' } | null;
  card: { last4: string; loaded_cents: number; voided: boolean } | null;
}
export interface FeedItem {
  id: string; kind: ErrandKind; title: string; spend_cap_cents: number; max_fee_cents: number;
  bonus_cents: number; deadline_at: string | null; distance_band: string; stall_count: number;
  auction_closes_at: string | null; my_bid_cents: number | null;
}
export interface NearbyRunner {
  runner_id: string; display_name: string; distance_band: string; cell_r9: string;
  completed_with_you: number; fix_age_seconds: number;
}
export interface BidView {
  id: string; runner: Counterparty & { completed_jobs: number }; fee_cents: number;
  eta_minutes: number; note: string | null; status: string;
}
export type BidsResponse = { sealed: true; count: number; closes_at: string } | { sealed: false; bids: BidView[] };

// ─────────────────────────────────────────────── stalls and approval

export const PriceItems = z.object({
  items: z.array(z.object({ id: uuid, price_cents: cents })).min(1).max(40),
});
export const EvidenceRequest = z.object({
  kind: z.enum(['goods', 'receipt']),
  content_type: z.enum(['image/jpeg', 'image/png']),
  taken_at: iso,
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});
export const DeclineStall = z.object({ reason: z.string().min(1).max(280) });
export const Substitute = z.object({
  line_item_id: uuid,
  label: z.string().min(1).max(80),
  qty: z.number().positive().max(9999),
  unit: z.string().min(1).max(16),
  price_cents: cents,
});
export const ReimbursementConfirm = z.object({ tranche_id: uuid, accept: z.boolean() });
export const Handover = z.object({ qr_token: z.string().min(10).max(200) });

export interface ApproveResponse {
  tranche: { id: string; seq: number; amount_cents: number; status: 'pending' };
  remaining_cap_cents: number;
  poll_after_ms: number;
}
export interface HandoverToken { qr_token: string; expires_at: string; rotates_in_ms: number }

// ─────────────────────────────────────────────── link and location

const b64 = z.string().regex(/^[A-Za-z0-9+/=_-]+$/).max(200);
export const LinkPublish = z.object({ public_key: b64 });
export const LinkAck = z.object({ link_hash: b64 });
export const LocationFix = z.object({
  errand_id: uuid,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy_m: z.number().min(0).max(10_000),
  heading_deg: z.number().min(0).max(360).nullable().default(null),
  seq: z.number().int().nonnegative(),
  hmac_tag: b64,
  recorded_at: iso,
});
export const LocationBatch = z.object({ fixes: z.array(LocationFix).min(1).max(4) });
export interface LinkState {
  state: 'pending_keys' | 'pending_ack' | 'active' | 'revoked';
  counterpart_key: string | null;
}
export interface LocationView {
  state: 'live' | 'linked_stale' | 'revoked' | 'pending';
  point?: { lat: number; lng: number; accuracy_m: number | null };
  seq?: number; hmac_tag?: string; recorded_at?: string; age_seconds?: number;
}

// ─────────────────────────────────────────────── money

export const TopUp = z.object({ amount_cents: positiveCents.max(15_000_000) });
export const Withdraw = z.object({ amount_cents: positiveCents });
export const PayoutRequest = z.object({ amount_cents: positiveCents });
export interface Wallet {
  currency: string;
  balance_cents: number;
  escrow: { errand_id: string; title: string; held_cents: number }[];
  recent: { id: string; reason: string; amount_cents: number; at: string }[];
}
export interface Earnings {
  currency: string;
  available_cents: number;
  reimbursements_owed_cents: number;
  lifetime_cents: number;
  payouts: { id: string; amount_cents: number; status: string; at: string }[];
  min_payout_cents: number;
}

// ─────────────────────────────────────────────── chat, safety, disputes

export const SendMessage = z.object({ body: z.string().min(1).max(1000) });
export interface Message { id: string; sender_id: string; body: string; at: string }
export const Sos = z.object({ lat: z.number().optional(), lng: z.number().optional() });
export const OpenDispute = z.object({
  errand_id: uuid,
  reason: z.enum(['goods_wrong', 'goods_missing', 'overcharged', 'no_show', 'safety', 'other']),
  detail: z.string().min(1).max(2000),
});

// ─────────────────────────────────────────────── ops

export const KycDecision = z.object({
  approve: z.boolean(),
  tier: z.number().int().min(1).max(3).optional(),
  reason: z.string().max(280).optional(),
});
export const STAFF_GRANTS = ['ops.read', 'kyc.review', 'evidence.view', 'ledger.read', 'location.read_cells',
  'audit.read', 'legal_ops', 'accounts.manage', 'staff.admin'] as const;
export const StaffGrants = z.object({ grants: z.array(z.enum(STAFF_GRANTS)).max(STAFF_GRANTS.length) });
export const Suspension = z.object({ reason: z.string().trim().min(8).max(280) });
export const SosResolve = z.object({ note: z.string().trim().min(4).max(1000) });

export const Ruling = z.object({
  outcome: z.enum(['requester_favour', 'runner_favour', 'split', 'void']),
  requester_cents: cents,
  runner_cents: cents,
  rationale: z.string().min(40).max(4000),
});

// ─────────────────────────────────────────────── errors

/** RFC 7807 body. Clients branch on `code`, never on `title`. */
export interface Problem {
  type: string; title: string; status: number; code: string;
  details?: Record<string, unknown>; request_id?: string;
}

export const ERROR_CODES = [
  'OTP_INVALID', 'OTP_THROTTLED', 'TIER_REQUIRED', 'ERRAND_STATE_INVALID', 'SPEND_CAP_EXCEEDED',
  'BID_CLOSED', 'RETAKE_EXHAUSTED', 'CARD_DECLINED', 'INSUFFICIENT_ESCROW', 'INSUFFICIENT_FUNDS',
  'PAYOUT_FAILED', 'IDEMPOTENCY_CONFLICT', 'RATE_LIMITED', 'NOT_FOUND', 'FORBIDDEN',
  'ALREADY_ASSIGNED', 'LINK_NOT_ESTABLISHED', 'CONSENT_REQUIRED', 'VALIDATION',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
