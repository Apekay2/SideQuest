// apps/worker/src/jobs/shared.ts

import type { Tx } from '@sidequest/db';
import { nextStatus, type ErrandStatus } from '@sidequest/domain/errand/machine';
import { later } from '../context.js';

/**
 * Every stall resolved and every tranche finished → handover. Called from each path that can
 * be the last to finish (a tranche loading, a reimbursement, a decline) so none can forget.
 */
export async function maybeAdvanceToHandover(tx: Tx, errandId: string): Promise<boolean> {
  const [r] = await tx<{ open_stalls: number; stalls: number; pending_tranches: number; status: ErrandStatus;
                         requester_id: string; runner_id: string | null }[]>`
    SELECT (SELECT count(*)::int FROM stall WHERE errand_id = ${errandId}
              AND status NOT IN ('approved','declined','skipped')) AS open_stalls,
           (SELECT count(*)::int FROM stall WHERE errand_id = ${errandId}) AS stalls,
           (SELECT count(*)::int FROM tranche t JOIN card c ON c.id = t.card_id
             WHERE c.errand_id = ${errandId} AND t.status = 'pending') AS pending_tranches,
           e.status, e.requester_id, e.runner_id
      FROM errand e WHERE e.id = ${errandId}`;
  // Basket-less errands reach handover by the runner's own "ready" step, not from here.
  if (!r || r.stalls === 0 || r.open_stalls > 0 || r.pending_tranches > 0) return false;
  if (r.status !== 'shopping' && r.status !== 'awaiting_approval') return false;
  await tx`UPDATE errand SET status = ${nextStatus(r.status, 'all_stalls_done', 'system')}, updated_at = now() WHERE id = ${errandId}`;
  await later(tx, 'notify', { accountId: r.requester_id, template: 'errand.handover', vars: { errandId } });
  await later(tx, 'eta.recompute', { errandId });
  return true;
}
