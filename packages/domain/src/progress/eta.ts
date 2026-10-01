// packages/domain/src/progress/eta.ts
// Checkpoint-based ETA. No routing provider, no map matching, no traffic feed.
// Progress is what has actually happened; the estimate is the sum of medians for what
// has not. Location corroborates — it never invents a checkpoint.

export type CheckpointKind =
  | 'assigned' | 'en_route' | 'arrived' | 'stall_submitted' | 'stall_approved' | 'handover';

export type Confidence = 'high' | 'medium' | 'low';

export interface Checkpoint {
  kind: CheckpointKind;
  stallId: string | null;
  reachedAt: number; // epoch ms
}

/** Median and p90 for one checkpoint, from `checkpoint_duration`. */
export interface DurationStat {
  medianSecs: number;
  p90Secs: number;
  samples: number;
  isSeed: boolean;
}

export interface EtaInput {
  now: number;
  checkpoints: readonly Checkpoint[];
  stallCount: number;
  /** Lookup for the remaining checkpoints, already resolved to the right bucket. */
  stat: (kind: CheckpointKind) => DurationStat;
  /** Last verified position fix, if any. */
  lastFixAtMs: number | null;
  /** Metres from the runner's last fix to the market, when both are known. */
  metresToPickup: number | null;
}

export interface EtaOutput {
  percentComplete: number;
  etaAtMs: number | null;
  etaLowMs: number | null;
  etaHighMs: number | null;
  confidence: Confidence;
  staleSinceMs: number | null;
}

/** Relative weight of each phase in the progress bar. Per-stall weight is shared out. */
const WEIGHTS: Record<CheckpointKind, number> = {
  assigned: 5,
  en_route: 15,
  arrived: 10,
  stall_submitted: 25,  // divided across stalls
  stall_approved: 25,   // divided across stalls
  handover: 20,
};

const STALE_AFTER_MS = 120_000;
const ARRIVAL_PROXIMITY_M = 200;

function reached(cps: readonly Checkpoint[], kind: CheckpointKind): boolean {
  return cps.some((c) => c.kind === kind);
}

function countOf(cps: readonly Checkpoint[], kind: CheckpointKind): number {
  return cps.filter((c) => c.kind === kind).length;
}

export function percentComplete(cps: readonly Checkpoint[], stallCount: number): number {
  const n = Math.max(stallCount, 1);
  let earned = 0;

  if (reached(cps, 'assigned')) earned += WEIGHTS.assigned;
  if (reached(cps, 'en_route')) earned += WEIGHTS.en_route;
  if (reached(cps, 'arrived')) earned += WEIGHTS.arrived;
  earned += (WEIGHTS.stall_submitted / n) * Math.min(countOf(cps, 'stall_submitted'), n);
  earned += (WEIGHTS.stall_approved / n) * Math.min(countOf(cps, 'stall_approved'), n);
  if (reached(cps, 'handover')) earned += WEIGHTS.handover;

  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  return Math.round(Math.min(earned / total, 1) * 100);
}

/** Checkpoints still ahead, in order, with per-stall steps expanded. */
function remaining(cps: readonly Checkpoint[], stallCount: number): CheckpointKind[] {
  const out: CheckpointKind[] = [];
  if (!reached(cps, 'en_route')) out.push('en_route');
  if (!reached(cps, 'arrived')) out.push('arrived');

  const submittedLeft = Math.max(stallCount - countOf(cps, 'stall_submitted'), 0);
  const approvedLeft = Math.max(stallCount - countOf(cps, 'stall_approved'), 0);
  for (let i = 0; i < submittedLeft; i++) out.push('stall_submitted');
  for (let i = 0; i < approvedLeft; i++) out.push('stall_approved');

  if (!reached(cps, 'handover')) out.push('handover');
  return out;
}

function confidenceOf(args: {
  stats: readonly DurationStat[];
  stale: boolean;
  anyCheckpoint: boolean;
}): Confidence {
  if (args.stale || !args.anyCheckpoint) return 'low';
  if (args.stats.some((s) => s.isSeed || s.samples < 20)) return 'medium';
  return 'high';
}

export function computeEta(input: EtaInput): EtaOutput {
  const { now, checkpoints, stallCount, stat } = input;
  const pct = percentComplete(checkpoints, stallCount);

  if (reached(checkpoints, 'handover')) {
    return { percentComplete: 100, etaAtMs: null, etaLowMs: null, etaHighMs: null,
             confidence: 'high', staleSinceMs: null };
  }

  const stale = input.lastFixAtMs !== null && now - input.lastFixAtMs > STALE_AFTER_MS;
  const staleSinceMs = stale ? input.lastFixAtMs : null;

  const ahead = remaining(checkpoints, stallCount);
  const stats = ahead.map(stat);

  let medianSecs = stats.reduce((acc, s) => acc + s.medianSecs, 0);
  const p90Secs = stats.reduce((acc, s) => acc + s.p90Secs, 0);

  // Corroboration, not invention: a runner already at the market will not spend the full
  // median getting there. Trim, but never skip the checkpoint itself.
  if (
    !reached(checkpoints, 'arrived') &&
    input.metresToPickup !== null &&
    input.metresToPickup <= ARRIVAL_PROXIMITY_M
  ) {
    medianSecs = Math.max(medianSecs - stat('en_route').medianSecs * 0.7, 0);
  }

  const confidence = confidenceOf({
    stats,
    stale,
    anyCheckpoint: checkpoints.length > 0,
  });

  // A stale fix widens the band rather than freezing the estimate.
  const widen = stale ? 1.5 : 1;
  const etaAtMs = now + medianSecs * 1000;

  return {
    percentComplete: pct,
    etaAtMs,
    etaLowMs: now + medianSecs * 1000 * 0.8,
    etaHighMs: now + p90Secs * 1000 * widen,
    confidence,
    staleSinceMs,
  };
}

/**
 * The UI contract: at low confidence show a RANGE, never a time. An ETA presented to the
 * minute that the system cannot support is worse than no ETA.
 */
export function shouldShowExactTime(confidence: Confidence): boolean {
  return confidence !== 'low';
}

/**
 * The on-time bonus adjudicates on the handover timestamp against the deadline.
 * It never reads the ETA — an estimate must not be able to pay anybody.
 */
export function bonusEarned(handoverAtMs: number, deadlineAtMs: number | null): boolean {
  if (deadlineAtMs === null) return false;
  return handoverAtMs <= deadlineAtMs;
}
