// apps/worker/src/jobs/progress.ts
// The progress service (06-services.md §6.9): checkpoints in, ETA out. Pure computation over
// events; restartable at will. Location corroborates, it never invents a checkpoint.

import { computeEta, type CheckpointKind, type DurationStat } from '@sidequest/domain/progress/eta';
import { type Handler, publish, str } from '../context.js';

/** Cold-start medians, labelled as seed data until real samples replace them (06 §6.9). */
const SEED: Record<CheckpointKind, DurationStat> = {
  assigned:        { medianSecs: 0,    p90Secs: 0,    samples: 0, isSeed: true },
  en_route:        { medianSecs: 300,  p90Secs: 600,  samples: 0, isSeed: true },
  arrived:         { medianSecs: 1200, p90Secs: 2100, samples: 0, isSeed: true },
  stall_submitted: { medianSecs: 600,  p90Secs: 1080, samples: 0, isSeed: true },
  stall_approved:  { medianSecs: 180,  p90Secs: 480,  samples: 0, isSeed: true },
  handover:        { medianSecs: 1500, p90Secs: 2700, samples: 0, isSeed: true },
};

export const checkpointRecord: Handler = async (payload, ctx) => {
  const errandId = str(payload, 'errandId');
  const kind = str(payload, 'kind');
  const stallId = typeof payload.stallId === 'string' ? payload.stallId : null;
  await ctx.deps.sql`
    INSERT INTO errand_checkpoint (errand_id, kind, stall_id, reached_at)
    VALUES (${errandId}, ${kind}, ${stallId}, now())
    ON CONFLICT (errand_id, kind, stall_id) DO NOTHING`;
  await etaRecompute({ errandId }, ctx);
};

export const etaRecompute: Handler = async (payload, ctx) => {
  const errandId = str(payload, 'errandId');
  const { sql } = ctx.deps;
  const [e] = await sql<{ kind: string; requester_id: string; runner_id: string | null; pickup_cell: string | null;
                          stall_count: number; pickup_lat: number | null; pickup_lng: number | null }[]>`
    SELECT e.kind, e.requester_id, e.runner_id, e.pickup_cell::text AS pickup_cell,
           (SELECT count(*)::int FROM stall s WHERE s.errand_id = e.id) AS stall_count,
           ST_Y(e.pickup::geometry) AS pickup_lat, ST_X(e.pickup::geometry) AS pickup_lng
      FROM errand e WHERE e.id = ${errandId}`;
  if (!e) return;
  const cps = await sql<{ kind: CheckpointKind; stall_id: string | null; reached_at: Date }[]>`
    SELECT kind, stall_id, reached_at FROM errand_checkpoint WHERE errand_id = ${errandId} ORDER BY reached_at`;
  // Learned medians for this kind, market cell and hour, falling back to the global row under
  // 20 samples, and to the seed table when nothing has been learned at all.
  const hour = new Date().getUTCHours();
  const learned = await sql<{ kind: CheckpointKind; median_secs: number; p90_secs: number; samples: number; is_seed: boolean; cell_r8: string | null }[]>`
    SELECT kind, median_secs, p90_secs, samples, is_seed, cell_r8::text AS cell_r8 FROM checkpoint_duration
     WHERE errand_kind = ${e.kind} AND (hour_bucket = ${hour} OR hour_bucket IS NULL)
       AND (cell_r8::text = ${e.pickup_cell} OR cell_r8 IS NULL)`;
  const stat = (k: CheckpointKind): DurationStat => {
    const local = learned.find((l) => l.kind === k && l.cell_r8 !== null && l.samples >= 20);
    const global = learned.find((l) => l.kind === k && l.cell_r8 === null);
    const row = local ?? global;
    return row ? { medianSecs: row.median_secs, p90Secs: row.p90_secs, samples: row.samples, isSeed: row.is_seed } : SEED[k];
  };

  const [fix] = e.runner_id
    ? await sql<{ recorded_at: Date; metres: number | null }[]>`
        SELECT rl.recorded_at,
               CASE WHEN ${e.pickup_lat}::float8 IS NULL THEN NULL
                    ELSE ST_Distance(rl.point, ST_SetSRID(ST_MakePoint(${e.pickup_lng}, ${e.pickup_lat}), 4326)::geography) END AS metres
          FROM runner_location rl WHERE rl.runner_id = ${e.runner_id} AND rl.errand_id = ${errandId}`
    : [];

  const out = computeEta({
    now: Date.now(),
    checkpoints: cps.map((c) => ({ kind: c.kind, stallId: c.stall_id, reachedAt: c.reached_at.getTime() })),
    stallCount: e.stall_count,
    stat,
    lastFixAtMs: fix?.recorded_at.getTime() ?? null,
    metresToPickup: fix?.metres ?? null,
  });
  const ts = (ms: number | null) => (ms === null ? null : new Date(ms));
  await sql`
    INSERT INTO errand_eta (errand_id, percent_complete, eta_at, eta_low_at, eta_high_at, confidence, stale_since, computed_at)
    VALUES (${errandId}, ${out.percentComplete}, ${ts(out.etaAtMs)}, ${ts(out.etaLowMs)}, ${ts(out.etaHighMs)},
            ${out.confidence}, ${ts(out.staleSinceMs)}, now())
    ON CONFLICT (errand_id) DO UPDATE SET percent_complete = EXCLUDED.percent_complete, eta_at = EXCLUDED.eta_at,
      eta_low_at = EXCLUDED.eta_low_at, eta_high_at = EXCLUDED.eta_high_at, confidence = EXCLUDED.confidence,
      stale_since = EXCLUDED.stale_since, computed_at = now()`;
  await publish(ctx.deps, e.requester_id, 'eta.updated', {
    errand_id: errandId, percent_complete: out.percentComplete,
    eta_at: out.etaAtMs ? new Date(out.etaAtMs).toISOString() : null, confidence: out.confidence,
  });
};
