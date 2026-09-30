// apps/mobile/src/i18n/useT.ts
// Every string goes through here (11-cross-platform.md §11.2). en.json and sw.json are
// key-identical, checked in CI (scripts/check-parity.mjs) and by the unit test.

import en from './en.json';
import sw from './sw.json';
import { useSession } from '../lib/session';

export type Key = keyof typeof en;
export type Lang = 'en' | 'sw';
const TABLES: Record<Lang, Record<Key, string>> = { en, sw };

export function translate(lang: Lang, key: Key, vars?: Record<string, string | number>): string {
  const raw = TABLES[lang][key] ?? TABLES.en[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] === undefined ? `{${k}}` : String(vars[k]))) : raw;
}

export interface T {
  (key: Key, vars?: Record<string, string | number>): string;
  lang: Lang;
  locale: string;
}

export function useT(): T {
  const lang = useSession((s) => s.language);
  const t = ((key: Key, vars?: Record<string, string | number>) => translate(lang, key, vars)) as T;
  t.lang = lang;
  t.locale = lang === 'sw' ? 'sw-KE' : 'en-KE';
  return t;
}
