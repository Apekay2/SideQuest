#!/usr/bin/env node
// The Cross-Platform Parity rule as a build gate: "brand is shared, chrome is native."
//
// 1. Platform branching lives in one file. Everything that differs between iOS and Android
//    (tab count, FAB, button heights, the destructive-confirm shape) is decided in
//    apps/mobile/src/platform/adaptive.ts; a Platform.OS check anywhere else is a second
//    place where the two apps can drift apart without the parity tests noticing.
// 2. English and Swahili carry the same keys, and each string the same {placeholders}, so a
//    screen never falls back to a key name or drops an amount in one language.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const src = join(root, 'apps/mobile/src');
const allowed = join(src, 'platform');
const problems = [];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

// ── 1. no Platform branching outside src/platform (tests may assert on either platform)
const BRANCHING = /\bPlatform\s*\.\s*(OS|select|Version)\b|from\s+['"]react-native['"][^;]*\bPlatform\b|\.(ios|android)\.(ts|tsx)$/;
for (const f of files(src)) {
  if (f.startsWith(allowed + '/') || /\.test\.tsx?$/.test(f)) continue;
  const text = readFileSync(f, 'utf8');
  if (/\.(ios|android)\.tsx?$/.test(f)) { problems.push(`${relative(root, f)}: platform-specific file outside src/platform`); continue; }
  text.split('\n').forEach((line, i) => {
    if (BRANCHING.test(line)) problems.push(`${relative(root, f)}:${i + 1}: Platform branching outside src/platform — add it to adaptive.ts`);
  });
}

// ── 2. i18n key and placeholder parity
const flatten = (o, prefix = '') => Object.entries(o).flatMap(([k, v]) =>
  v && typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, String(v)]]);
const load = (lang) => new Map(flatten(JSON.parse(readFileSync(join(src, `i18n/${lang}.json`), 'utf8'))));
const en = load('en');
const sw = load('sw');
const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
for (const k of en.keys()) if (!sw.has(k)) problems.push(`i18n: "${k}" is in en.json but not sw.json`);
for (const k of sw.keys()) if (!en.has(k)) problems.push(`i18n: "${k}" is in sw.json but not en.json`);
for (const [k, v] of en) {
  if (sw.has(k) && holes(v) !== holes(sw.get(k))) problems.push(`i18n: "${k}" placeholders differ — en {${holes(v)}} vs sw {${holes(sw.get(k))}}`);
  if (sw.has(k) && sw.get(k).trim() === '') problems.push(`i18n: "${k}" is empty in sw.json`);
}

if (problems.length) {
  for (const p of problems) console.error(`  ${p}`);
  console.error(`::error::parity check: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`Parity check passed: Platform branching confined to src/platform; ${en.size} i18n keys match in en and sw.`);
