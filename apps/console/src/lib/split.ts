// The ruling form's arithmetic. The API refuses any split that does not add up to what escrow
// holds (and the worker checks again against the ledger); this is the same rule, shown live so
// the officer never learns it from a rejection.

export type Outcome = 'runner_favour' | 'split' | 'requester_favour' | 'void';

export const OUTCOMES: { value: Outcome; label: string; tone: 'sage' | 'terracotta' | 'outline' | 'quiet' }[] = [
  { value: 'runner_favour', label: 'Release to runner', tone: 'sage' },
  { value: 'split', label: 'Split 50/50', tone: 'terracotta' },
  { value: 'requester_favour', label: 'Refund requester', tone: 'outline' },
  { value: 'void', label: 'Void, no fault', tone: 'quiet' },
];

export const OUTCOME_LABEL: Record<Outcome, string> = {
  runner_favour: 'Release', split: 'Split', requester_favour: 'Refund', void: 'Void',
};

export const MIN_RATIONALE = 40;

/** The split each outcome starts from. An odd cent in a 50/50 goes back to the requester. */
export function preset(outcome: Outcome, heldCents: number, hasRunner: boolean): { requester: number; runner: number } {
  switch (outcome) {
    case 'runner_favour': return hasRunner ? { requester: 0, runner: heldCents } : { requester: heldCents, runner: 0 };
    case 'split': {
      if (!hasRunner) return { requester: heldCents, runner: 0 };
      const runner = Math.floor(heldCents / 2);
      return { requester: heldCents - runner, runner };
    }
    case 'requester_favour':
    case 'void':
      return { requester: heldCents, runner: 0 };
  }
}

export interface Check { ok: boolean; problems: string[]; remainder: number }

export function check(input: { outcome: Outcome | null; requester: number; runner: number; rationale: string },
                      heldCents: number, hasRunner: boolean): Check {
  const problems: string[] = [];
  const remainder = heldCents - input.requester - input.runner;
  if (!input.outcome) problems.push('Choose a ruling.');
  if (!Number.isInteger(input.requester) || !Number.isInteger(input.runner) || input.requester < 0 || input.runner < 0) {
    problems.push('Amounts must be whole, non-negative shillings.');
  } else if (remainder !== 0) {
    problems.push(remainder > 0 ? 'Part of the escrow is not assigned.' : 'The split is more than escrow holds.');
  }
  if (!hasRunner && input.runner > 0) problems.push('There is no runner to pay.');
  const len = input.rationale.trim().length;
  if (len < MIN_RATIONALE) problems.push(`The rationale needs ${MIN_RATIONALE - len} more characters.`);
  return { ok: problems.length === 0, problems, remainder };
}

/** Shillings typed by a person → cents. Rejects anything that is not a plain amount. */
export function toCents(text: string): number {
  const t = text.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return Number.NaN;
  return Math.round(Number(t) * 100);
}
