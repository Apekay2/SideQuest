// 11-cross-platform.md §11.7 check 1: en.json and sw.json stay key-identical, and every
// placeholder a string uses exists in its translation — a missing {amount} in Swahili would
// print an Approve button with no price on it.
import en from './en.json';
import sw from './sw.json';

const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('en and sw have exactly the same keys', () => {
  expect(Object.keys(sw).sort()).toEqual(Object.keys(en).sort());
});

test('every translation carries the same placeholders', () => {
  for (const k of Object.keys(en) as (keyof typeof en)[]) {
    expect({ k, vars: vars(sw[k]) }).toEqual({ k, vars: vars(en[k]) });
  }
});

test('no translation is empty', () => {
  for (const v of [...Object.values(en), ...Object.values(sw)]) expect(v.trim().length).toBeGreaterThan(0);
});
