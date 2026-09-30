// packages/domain/src/errand/machine.ts
// The errand state machine. Every transition in the product is in this table.
// An unlisted transition is a bug, and it throws.

export type ErrandStatus =
  | 'draft' | 'open' | 'awaiting_funds' | 'awarded' | 'en_route' | 'shopping'
  | 'awaiting_approval' | 'handover' | 'settled' | 'cancelled' | 'disputed' | 'expired';

export type ErrandEvent =
  | 'publish' | 'fund' | 'award' | 'auction_expired' | 'start' | 'arrive'
  | 'submit_stall' | 'approve_stall' | 'all_stalls_done' | 'handover_scanned'
  | 'cancel' | 'raise_dispute' | 'resolve_dispute' | 'deadline_passed';

export type Actor = 'requester' | 'runner' | 'system' | 'legal_ops';

interface Transition {
  from: ErrandStatus;
  event: ErrandEvent;
  to: ErrandStatus;
  by: readonly Actor[];
}

const TRANSITIONS: readonly Transition[] = [
  { from: 'draft',             event: 'publish',          to: 'awaiting_funds',    by: ['requester'] },
  { from: 'awaiting_funds',    event: 'fund',             to: 'open',              by: ['system'] },
  { from: 'awaiting_funds',    event: 'cancel',           to: 'cancelled',         by: ['requester'] },
  { from: 'open',              event: 'award',            to: 'awarded',           by: ['requester'] },
  { from: 'open',              event: 'auction_expired',  to: 'expired',           by: ['system'] },
  { from: 'open',              event: 'cancel',           to: 'cancelled',         by: ['requester'] },
  { from: 'awarded',           event: 'start',            to: 'en_route',          by: ['runner'] },
  { from: 'awarded',           event: 'cancel',           to: 'cancelled',         by: ['requester', 'runner'] },
  { from: 'en_route',          event: 'arrive',           to: 'shopping',          by: ['runner'] },
  { from: 'en_route',          event: 'cancel',           to: 'cancelled',         by: ['requester', 'runner'] },
  { from: 'shopping',          event: 'submit_stall',     to: 'awaiting_approval', by: ['runner'] },
  { from: 'awaiting_approval', event: 'approve_stall',    to: 'shopping',          by: ['requester'] },
  { from: 'awaiting_approval', event: 'all_stalls_done',  to: 'handover',          by: ['system'] },
  { from: 'shopping',          event: 'all_stalls_done',  to: 'handover',          by: ['system'] },
  { from: 'handover',          event: 'handover_scanned', to: 'settled',           by: ['runner'] },
  { from: 'shopping',          event: 'raise_dispute',    to: 'disputed',          by: ['requester', 'runner'] },
  { from: 'awaiting_approval', event: 'raise_dispute',    to: 'disputed',          by: ['requester', 'runner'] },
  { from: 'handover',          event: 'raise_dispute',    to: 'disputed',          by: ['requester', 'runner'] },
  { from: 'settled',           event: 'raise_dispute',    to: 'disputed',          by: ['requester', 'runner'] },
  { from: 'disputed',          event: 'resolve_dispute',  to: 'settled',           by: ['legal_ops'] },
  { from: 'en_route',          event: 'deadline_passed',  to: 'en_route',          by: ['system'] },
  { from: 'shopping',          event: 'deadline_passed',  to: 'shopping',          by: ['system'] },
];

/** States from which no further transition is possible. Cards must be voided on entry. */
export const TERMINAL: readonly ErrandStatus[] = ['settled', 'cancelled', 'expired'];

/** States in which a card may hold value. The nightly sweeper voids cards outside these. */
export const CARD_ACTIVE: readonly ErrandStatus[] = [
  'awarded', 'en_route', 'shopping', 'awaiting_approval', 'handover', 'disputed',
];

export class IllegalTransitionError extends Error {
  readonly code = 'ERRAND_STATE_INVALID';
  constructor(
    readonly from: ErrandStatus,
    readonly event: ErrandEvent,
    readonly by: Actor,
  ) {
    super(`Cannot ${event} an errand in state "${from}" as ${by}`);
    this.name = 'IllegalTransitionError';
  }
}

export function nextStatus(from: ErrandStatus, event: ErrandEvent, by: Actor): ErrandStatus {
  const match = TRANSITIONS.find((t) => t.from === from && t.event === event && t.by.includes(by));
  if (!match) throw new IllegalTransitionError(from, event, by);
  return match.to;
}

export function canTransition(from: ErrandStatus, event: ErrandEvent, by: Actor): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.event === event && t.by.includes(by));
}

export function isTerminal(status: ErrandStatus): boolean {
  return TERMINAL.includes(status);
}
