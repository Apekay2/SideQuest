// apps/api/src/lib/errands.ts
// Reading an errand as its caller sees it. Every query runs inside the caller's RLS scope, so
// a section the caller may not see (stalls for a feed viewer, a card for nobody but the
// parties) comes back empty rather than being filtered here.

import type { Tx } from '@sidequest/db';
import type { ErrandDetail, ErrandSummary, Stall, Tranche, Counterparty } from '@sidequest/contracts';
import type { StoragePort } from '@sidequest/adapters';
import { nextStatus, type ErrandStatus } from '@sidequest/domain/errand/machine';
import { AppError } from '../plugins/errors.js';

export interface ErrandRow {
  id: string; requester_id: string; runner_id: string | null; kind: ErrandSummary['kind'];
  status: ErrandStatus; title: string; notes: string | null;
  spend_cap_cents: number; spent_cents: number; max_fee_cents: number; agreed_fee_cents: number | null;
  bonus_cents: number; bonus_earned: boolean | null; deadline_at: Date | null; created_at: Date;
  assignment_mode: 'pick' | 'open'; funding_mode: 'upfront' | 'tranche';
  offered_to: string | null; offer_expires_at: Date | null; auction_closes_at: Date | null;
  auction_minutes: number; awarded_bid_id: string | null; currency: 'KES'; market: string;
  handover_at: Date | null; assigned_at: Date | null;
}

/** Lock the errand row for the rest of the transaction, or 404 if the caller cannot see it. */
export async function lockErrand(tx: Tx, id: string): Promise<ErrandRow> {
  const [e] = await tx<ErrandRow[]>`SELECT * FROM errand WHERE id = ${id} FOR UPDATE`;
  if (!e) throw new AppError(404, 'NOT_FOUND', 'Errand not found');
  return e;
}

export async function readErrand(tx: Tx, id: string): Promise<ErrandRow> {
  const [e] = await tx<ErrandRow[]>`SELECT * FROM errand WHERE id = ${id}`;
  if (!e) throw new AppError(404, 'NOT_FOUND', 'Errand not found');
  return e;
}

export function assertRequester(e: ErrandRow, actorId: string) {
  if (e.requester_id !== actorId) throw new AppError(403, 'FORBIDDEN', 'Not your errand');
}

export function assertRunner(e: ErrandRow, actorId: string) {
  if (e.runner_id !== actorId) throw new AppError(403, 'FORBIDDEN', 'You are not running this errand');
}

export function summary(
  e: ErrandRow, actorId: string, stallCount: number, stallsDone: number,
  extra: { counterparty_name?: string | null; stall_states?: ErrandSummary['stall_states']; eta_at?: Date | null } = {},
): ErrandSummary {
  return {
    id: e.id, kind: e.kind, status: e.status, title: e.title,
    spend_cap_cents: e.spend_cap_cents, spent_cents: e.spent_cents, max_fee_cents: e.max_fee_cents,
    agreed_fee_cents: e.agreed_fee_cents, bonus_cents: e.bonus_cents,
    deadline_at: e.deadline_at?.toISOString() ?? null, created_at: e.created_at.toISOString(),
    stall_count: stallCount, stalls_done: stallsDone,
    role: e.requester_id === actorId ? 'requester' : 'runner',
    counterparty_name: extra.counterparty_name ?? null,
    stall_states: extra.stall_states ?? [],
    eta_at: extra.eta_at ? extra.eta_at.toISOString() : null,
  };
}

async function counterparty(tx: Tx, id: string | null): Promise<Counterparty | null> {
  if (!id) return null;
  const [a] = await tx<Counterparty[]>`SELECT id, display_name, verification_tier FROM account WHERE id = ${id}`;
  return a ?? null;
}

export async function loadStalls(tx: Tx, errandId: string, storage: StoragePort): Promise<Stall[]> {
  const stalls = await tx<{ id: string; seq: number; name: string; till_number: string | null;
                            status: Stall['status']; total_cents: number }[]>`
    SELECT id, seq, name, till_number, status, total_cents FROM stall WHERE errand_id = ${errandId} ORDER BY seq`;
  if (stalls.length === 0) return [];
  const sids = stalls.map((s) => s.id);
  const items = await tx<{ id: string; stall_id: string; label: string; qty: string; unit: string;
                           price_cents: number | null; accepted: boolean | null; sub_label: string | null }[]>`
    SELECT i.id, i.stall_id, i.label, i.qty::text AS qty, i.unit, i.price_cents, i.accepted, o.label AS sub_label
      FROM line_item i LEFT JOIN line_item o ON o.id = i.substituted_for
     WHERE i.stall_id = ANY(${sids}::uuid[])
     -- The order the requester wrote them in; a substitute takes its original's place.
     ORDER BY i.stall_id, COALESCE(o.position, i.position), i.position`;
  const evidence = await tx<{ stall_id: string; object_key: string; attempt: number; rejected: boolean }[]>`
    SELECT DISTINCT ON (stall_id) stall_id, object_key, attempt, rejected
      FROM evidence WHERE errand_id = ${errandId} AND kind = 'goods' AND stall_id IS NOT NULL
     ORDER BY stall_id, created_at DESC`;
  const photo = new Map<string, { key: string; attempt: number }>();
  for (const ev of evidence) if (!ev.rejected) photo.set(ev.stall_id, { key: ev.object_key, attempt: ev.attempt });

  return Promise.all(stalls.map(async (s) => {
    const p = photo.get(s.id);
    return {
      ...s,
      photo_url: p ? await storage.presignGet(p.key, 300) : null,
      evidence_attempts: evidence.find((e) => e.stall_id === s.id)?.attempt ?? 0,
      items: items.filter((i) => i.stall_id === s.id).map((i) => ({
        id: i.id, label: i.label, qty: Number(i.qty), unit: i.unit, price_cents: i.price_cents,
        substituted_for_label: i.sub_label, accepted: i.accepted,
      })),
    };
  }));
}

export async function loadTranches(tx: Tx, errandId: string): Promise<Tranche[]> {
  const rows = await tx<{ id: string; seq: number; stall_id: string; amount_cents: number;
                          status: Tranche['status']; reimbursement_confirmed: boolean | null }[]>`
    SELECT t.id, t.seq, t.stall_id, t.amount_cents, t.status, t.reimbursement_confirmed
      FROM tranche t JOIN card c ON c.id = t.card_id WHERE c.errand_id = ${errandId} ORDER BY t.seq`;
  if (rows.length === 0) return [];
  const attempts = await tx<{ tranche_id: string; rung: string; result: string; provider_code: string | null; created_at: Date }[]>`
    SELECT tranche_id, rung, result, provider_code, created_at FROM card_attempt
     WHERE tranche_id = ANY(${rows.map((r) => r.id)}::uuid[]) ORDER BY created_at`;
  return rows.map((r) => ({
    ...r,
    attempts: attempts.filter((a) => a.tranche_id === r.id)
      .map((a) => ({ rung: a.rung, result: a.result, code: a.provider_code, at: a.created_at.toISOString() })),
  }));
}

export async function loadDetail(tx: Tx, id: string, actorId: string, storage: StoragePort): Promise<ErrandDetail> {
  const [e] = await tx<(ErrandRow & { pickup_lat: number | null; pickup_lng: number | null; pickup_label: string | null;
                                      dropoff_lat: number; dropoff_lng: number; dropoff_label: string })[]>`
    SELECT e.*, ST_Y(e.pickup::geometry) AS pickup_lat, ST_X(e.pickup::geometry) AS pickup_lng,
           ST_Y(e.dropoff::geometry) AS dropoff_lat, ST_X(e.dropoff::geometry) AS dropoff_lng
      FROM errand e WHERE e.id = ${id}`;
  if (!e) throw new AppError(404, 'NOT_FOUND', 'Errand not found');

  const isParty = e.requester_id === actorId || e.runner_id === actorId;
  const [stalls, tranches, requester, runner] = await Promise.all([
    loadStalls(tx, id, storage),
    loadTranches(tx, id),
    counterparty(tx, e.requester_id),
    counterparty(tx, e.runner_id),
  ]);
  const [escrow] = await tx<{ funded_cents: number; held_cents: number; frozen_at: Date | null }[]>`
    SELECT funded_cents, held_cents, frozen_at FROM escrow WHERE errand_id = ${id}`;
  const [fee] = await tx<{ requester_fee_cents: number; runner_fee_cents: number }[]>`
    SELECT requester_fee_cents, runner_fee_cents FROM errand_fee WHERE errand_id = ${id}`;
  const [eta] = await tx<{ percent_complete: number; eta_at: Date | null; confidence: 'high' | 'medium' | 'low' }[]>`
    SELECT percent_complete, eta_at, confidence FROM errand_eta WHERE errand_id = ${id}`;
  const [card] = await tx<{ last4: string; loaded_cents: number; voided_at: Date | null }[]>`
    SELECT last4, loaded_cents, voided_at FROM card WHERE errand_id = ${id}`;
  const stallCount = stalls.length || (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM stall WHERE errand_id = ${id}`)[0]!.n;
  const done = stalls.filter((s) => s.status === 'approved' || s.status === 'declined' || s.status === 'skipped').length;

  const [eta0] = await tx<{ eta_at: Date | null }[]>`SELECT eta_at FROM errand_eta WHERE errand_id = ${id}`;
  const other = e.requester_id === actorId ? runner : requester;
  return {
    ...summary(e, actorId, stallCount, done, {
      counterparty_name: other?.display_name ?? null, stall_states: stalls.map((s) => s.status), eta_at: eta0?.eta_at ?? null,
    }),
    notes: isParty ? e.notes : null,
    assignment_mode: e.assignment_mode,
    funding_mode: e.funding_mode,
    pickup: e.pickup_lat !== null ? { lat: e.pickup_lat, lng: e.pickup_lng!, label: e.pickup_label } : null,
    // The dropoff is the requester's door. A runner sees it once assigned, never from the feed.
    dropoff: isParty
      ? { lat: e.dropoff_lat, lng: e.dropoff_lng, label: e.dropoff_label }
      : { lat: Math.round(e.dropoff_lat * 100) / 100, lng: Math.round(e.dropoff_lng * 100) / 100, label: '' },
    auction_closes_at: e.auction_closes_at?.toISOString() ?? null,
    offered_to: e.requester_id === actorId ? e.offered_to : null,
    requester: requester ?? { id: e.requester_id, display_name: 'Requester', verification_tier: 1 },
    runner,
    stalls,
    tranches,
    escrow: escrow ? { funded_cents: escrow.funded_cents, held_cents: escrow.held_cents, frozen: Boolean(escrow.frozen_at) } : null,
    fee: fee ?? null,
    eta: eta ? { percent_complete: eta.percent_complete, eta_at: eta.eta_at?.toISOString() ?? null, confidence: eta.confidence } : null,
    card: card ? { last4: card.last4, loaded_cents: card.loaded_cents, voided: Boolean(card.voided_at) } : null,
  };
}

/**
 * After a stall is resolved: if every stall is approved/declined/skipped and every tranche has
 * finished loading, the errand moves to handover. Called from the approve, decline and ladder
 * paths so none of them can forget.
 */
export async function maybeAdvanceToHandover(tx: Tx, errandId: string): Promise<boolean> {
  const [r] = await tx<{ open_stalls: number; pending_tranches: number; status: string }[]>`
    SELECT (SELECT count(*)::int FROM stall WHERE errand_id = ${errandId}
              AND status NOT IN ('approved','declined','skipped')) AS open_stalls,
           (SELECT count(*)::int FROM tranche t JOIN card c ON c.id = t.card_id
             WHERE c.errand_id = ${errandId} AND t.status = 'pending') AS pending_tranches,
           (SELECT status::text FROM errand WHERE id = ${errandId}) AS status`;
  if (!r || r.open_stalls > 0 || r.pending_tranches > 0) return false;
  if (r.status !== 'shopping' && r.status !== 'awaiting_approval') return false;
  const to = nextStatus(r.status as ErrandStatus, 'all_stalls_done', 'system');
  await tx`UPDATE errand SET status = ${to}, updated_at = now() WHERE id = ${errandId}`;
  return true;
}
