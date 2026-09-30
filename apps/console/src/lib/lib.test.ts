import { describe, expect, test } from 'vitest';
import { ksh, waited, ref, when } from './format';
import { preset, check, toCents } from './split';

describe('format', () => {
  test('shillings with separators, cents only when they exist', () => {
    expect(ksh(119_000)).toBe('1,190');
    expect(ksh(38_050)).toBe('380.50');
    expect(ksh(0)).toBe('0');
  });
  test('waiting time at the grain an officer acts on', () => {
    expect(waited(20)).toBe('1 min');
    expect(waited(35 * 60)).toBe('35 min');
    expect(waited(4 * 3600 + 59 * 60)).toBe('4 h');
    expect(waited(26 * 3600)).toBe('1 d');
  });
  test('references are short and stable', () => {
    expect(ref('DSP', '3f9a1c2e-0000-4000-8000-000000000000')).toBe('DSP-3F9A1C');
  });
  test('times are Nairobi time', () => {
    expect(when('2026-08-22T06:14:00Z')).toBe('22 Aug 09:14');
  });
});

describe('ruling arithmetic', () => {
  test('presets always add up to escrow; the odd cent goes to the requester', () => {
    for (const o of ['runner_favour', 'split', 'requester_favour', 'void'] as const) {
      const p = preset(o, 147_401, true);
      expect(p.requester + p.runner).toBe(147_401);
    }
    expect(preset('split', 147_401, true)).toEqual({ requester: 73_701, runner: 73_700 });
  });
  test('with no runner nothing is paid to a runner, whatever the outcome', () => {
    expect(preset('runner_favour', 5_000, false)).toEqual({ requester: 5_000, runner: 0 });
    expect(check({ outcome: 'split', requester: 0, runner: 5_000, rationale: 'x'.repeat(40) }, 5_000, false).problems)
      .toContain('There is no runner to pay.');
  });
  test('refuses what the API would refuse: mismatch and a short rationale', () => {
    const short = check({ outcome: 'split', requester: 1, runner: 1, rationale: 'too short' }, 5, true);
    expect(short.ok).toBe(false);
    expect(short.remainder).toBe(3);
    expect(short.problems).toEqual(['Part of the escrow is not assigned.', 'The rationale needs 31 more characters.']);
    expect(check({ outcome: 'void', requester: 5, runner: 0, rationale: 'y'.repeat(40) }, 5, true).ok).toBe(true);
  });
  test('typed shillings become cents; anything else is refused', () => {
    expect(toCents('1,190')).toBe(119_000);
    expect(toCents('380.5')).toBe(38_050);
    expect(Number.isNaN(toCents('-3'))).toBe(true);
    expect(Number.isNaN(toCents('1e3'))).toBe(true);
  });
});

describe('refresh single-flight', async () => {
  const { rotate } = await import('./refresh');
  test('concurrent and trailing callers with one token cause exactly one rotation', async () => {
    let calls = 0;
    const fake = (async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return new Response(JSON.stringify({ access: 'a2', refresh: 'r2', expires_in: 900, account: { role: 'staff' } }));
    }) as typeof fetch;
    const results = await Promise.all([1, 2, 3].map(() => rotate('r1-token', fake)));
    const late = await rotate('r1-token', fake);
    expect(calls).toBe(1);
    expect(new Set([...results, late].map((r) => r?.refresh))).toEqual(new Set(['r2']));
    await rotate('other-token', fake);
    expect(calls).toBe(2);
  });
});
