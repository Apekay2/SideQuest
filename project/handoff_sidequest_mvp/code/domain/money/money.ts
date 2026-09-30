// packages/domain/src/money/money.ts
// Integer minor units, currency-tagged. There is no float in this system.
//
// WHAT CHANGED AND WHY (10-panel-review.md §10.6.1). `Cents` was an untagged number, so
// nothing stopped a KES amount being added to a future USD one, and every `/ 100` in the
// codebase was an assumption rather than a lookup. The exponent stays at 2 by decision —
// see currency.ts — but the currency now travels WITH the amount, because that is the part
// that cannot be retrofitted once the ledger has rows in it.
//
// Migration shape: `Cents` remains as a deprecated alias of the minor-unit brand, and the
// arithmetic helpers still accept it, so existing call sites keep compiling. New code takes
// `Money`. The ledger and the rails take `Money` only — those are the two boundaries where
// a missing currency becomes unrecoverable.

import { type CurrencyCode, type Currency, currencyOf, assertSupported } from './currency.js';

/** A count of minor units. Carries no currency: only `Money` does. */
export type Minor = number & { readonly __brand: 'Minor' };

/** @deprecated Use `Money`. Retained so the pre-currency call sites still compile. */
export type Cents = Minor;

export interface Money {
  readonly minor: Minor;
  readonly currency: CurrencyCode;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function cents(value: number): Minor {
  if (!Number.isInteger(value)) throw new MoneyError(`Money must be an integer number of minor units, got ${value}`);
  if (!Number.isSafeInteger(value)) throw new MoneyError(`Money out of safe integer range: ${value}`);
  return value as Minor;
}

/** Alias with the name new code should use. Same validation. */
export const minor = cents;

export const ZERO = cents(0);

// ─────────────────────────────────────────────── tagged constructors

/**
 * The only way to make a `Money`. Validates the integer AND the currency, so an unsupported
 * or zero-decimal currency cannot reach arithmetic or the ledger.
 */
export function money(value: number, currency: CurrencyCode): Money {
  assertSupported(currency);
  return { minor: cents(value), currency };
}

export const zeroIn = (currency: CurrencyCode): Money => money(0, currency);

/** Lift an untagged legacy amount. Every call is a place the migration is not finished, so
 *  they are easy to grep for. */
export function tag(value: Minor, currency: CurrencyCode): Money {
  return money(value, currency);
}

/**
 * Mixing currencies is an error, never a conversion. FX belongs in an explicit conversion
 * posting group that records the rate, the source and the timestamp — never implicitly
 * inside a business calculation.
 */
function sameCurrency(a: Money, b: Money, op: string): CurrencyCode {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Cannot ${op} ${a.currency} and ${b.currency}; convert explicitly`);
  }
  return a.currency;
}

// ─────────────────────────────────────────────── arithmetic

export const add = (a: Cents, b: Cents): Cents => cents(a + b);
export const sub = (a: Cents, b: Cents): Cents => cents(a - b);
export const gt = (a: Cents, b: Cents): boolean => a > b;
export const gte = (a: Cents, b: Cents): boolean => a >= b;
export const min = (a: Cents, b: Cents): Cents => (a < b ? a : b);
export const isPositive = (a: Cents): boolean => a > 0;

export const addM = (a: Money, b: Money): Money => money(a.minor + b.minor, sameCurrency(a, b, 'add'));
export const subM = (a: Money, b: Money): Money => money(a.minor - b.minor, sameCurrency(a, b, 'subtract'));
export const gtM = (a: Money, b: Money): boolean => (sameCurrency(a, b, 'compare'), a.minor > b.minor);
export const gteM = (a: Money, b: Money): boolean => (sameCurrency(a, b, 'compare'), a.minor >= b.minor);
export const minM = (a: Money, b: Money): Money => (sameCurrency(a, b, 'compare'), a.minor <= b.minor ? a : b);
export const isPositiveM = (a: Money): boolean => a.minor > 0;
export const isZeroM = (a: Money): boolean => a.minor === 0;

/** Sum with an explicit empty case so `sum([])` cannot silently mean "free". */
export function sum(values: readonly Cents[]): Cents {
  return values.reduce<Cents>((acc, v) => add(acc, v), ZERO);
}

/** Currency-aware sum. Requires the currency up front precisely so the empty case is still
 *  a typed zero rather than an untagged one. */
export function sumM(values: readonly Money[], currency: CurrencyCode): Money {
  return values.reduce<Money>((acc, v) => addM(acc, v), zeroIn(currency));
}

/**
 * Split `total` into `parts` shares that sum EXACTLY to `total`.
 * Remainder minor units go to the earliest shares. Used for escrow splits in rulings.
 *
 * Positive totals only. With a negative total the remainder logic distributed nothing and
 * the shares summed short — `split(cents(-5), 2)` returned [-2, -2]. A ruling that split a
 * reversal would have lost a unit per call and failed the balance trigger at commit, which
 * is a 500 in front of Legal Operations mid-dispute rather than a clean error.
 */
export function split(total: Cents, parts: number): Cents[] {
  if (!Number.isInteger(parts) || parts < 1) throw new MoneyError(`Invalid split count ${parts}`);
  if (total < 0) throw new MoneyError(`Cannot split a negative amount (${total}); split the reversal instead`);
  const base = Math.trunc(total / parts);
  const remainder = total - base * parts;
  return Array.from({ length: parts }, (_, i) => cents(base + (i < remainder ? 1 : 0)));
}

export function splitM(total: Money, parts: number): Money[] {
  return split(total.minor, parts).map((m) => money(m, total.currency));
}

// ─────────────────────────────────────────────── display

/**
 * Display only. Never parse this back.
 *
 * The exponent comes from the registry rather than a literal 100, so this function is
 * already correct for a zero- or three-decimal currency on the day one is enabled. That is
 * the whole point of storing the exponent: the display layer is where a hardcoded 2 hurts
 * first and is noticed last.
 */
export function format(value: Money, locale?: string): string {
  const c: Currency = currencyOf(value.currency);
  const divisor = 10 ** c.exponent;
  const major = value.minor / divisor;
  const whole = value.minor % divisor === 0;
  const formatted = new Intl.NumberFormat(locale ?? 'en-KE', {
    minimumFractionDigits: whole ? 0 : c.exponent,
    maximumFractionDigits: c.exponent,
  }).format(major);
  return `${c.symbol} ${formatted}`.replace(/\s+/, ' ');
}

/** @deprecated Use `format(money(v, 'KES'), locale)`. Kept for the pre-currency call sites. */
export function formatKes(value: Cents, locale: 'en' | 'sw' = 'en'): string {
  return format({ minor: value, currency: 'KES' }, locale === 'sw' ? 'sw-KE' : 'en-KE');
}
