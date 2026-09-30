// packages/domain/src/money/currency.ts
// The currency registry and the market table that binds a country to its money, rails and
// limits. This file exists so that "which currency is this amount in" is a value carried on
// the amount, not an assumption spread across forty files.
//
// DELIBERATE CONSTRAINT (agreed with the product owner): every currency the platform will
// accept in the foreseeable roadmap has a TWO-DECIMAL minor unit, and `assertSupported()`
// refuses anything else. The exponent is still stored per currency rather than hardcoded,
// because the expensive part of a multi-currency migration is not the arithmetic — it is
// discovering, after the ledger has a million rows in it, that the exponent was an
// assumption rather than a column. Adding JPY (exponent 0) or KWD (exponent 3) later is
// then a registry entry plus lifting the gate in `assertSupported`, not a rewrite.
//
// The gate is what makes that honest: code written today cannot silently acquire a
// zero-decimal currency and start dividing by 100.

export type CurrencyCode = 'KES' | 'UGX' | 'TZS' | 'RWF' | 'NGN' | 'ZAR' | 'GHS' | 'USD' | 'EUR' | 'GBP';

export interface Currency {
  code: CurrencyCode;
  /** Minor units per major unit, as a power of ten. 2 = cents. */
  exponent: 0 | 2 | 3;
  /** Prefix shown to users. Not a substitute for the code in any stored record. */
  symbol: string;
  /** ISO 4217 numeric, for rails and reports that demand it. */
  numeric: string;
}

// Exponents are the real ISO 4217 values, including the ones the platform does not yet
// accept. UGX, TZS and RWF are genuinely zero-decimal currencies — the three markets most
// likely to be next — so they are listed truthfully and blocked by the gate rather than
// quietly mis-modelled as two-decimal.
export const CURRENCIES: Readonly<Record<CurrencyCode, Currency>> = Object.freeze({
  KES: { code: 'KES', exponent: 2, symbol: 'KSh',  numeric: '404' },
  UGX: { code: 'UGX', exponent: 0, symbol: 'USh',  numeric: '800' },
  TZS: { code: 'TZS', exponent: 0, symbol: 'TSh',  numeric: '834' },
  RWF: { code: 'RWF', exponent: 0, symbol: 'FRw',  numeric: '646' },
  NGN: { code: 'NGN', exponent: 2, symbol: '₦',    numeric: '566' },
  ZAR: { code: 'ZAR', exponent: 2, symbol: 'R',    numeric: '710' },
  GHS: { code: 'GHS', exponent: 2, symbol: 'GH₵',  numeric: '936' },
  USD: { code: 'USD', exponent: 2, symbol: '$',    numeric: '840' },
  EUR: { code: 'EUR', exponent: 2, symbol: '€',    numeric: '978' },
  GBP: { code: 'GBP', exponent: 2, symbol: '£',    numeric: '826' },
});

/** Currencies the money code is currently proven against. Two decimals only, by decision. */
export const SUPPORTED: readonly CurrencyCode[] = ['KES'];

/** Currencies whose registry entry is correct but whose exponent this codebase cannot yet
 *  handle. Listed so the block is a known state, not a surprise. */
export const BLOCKED_UNTIL_EXPONENT_WORK: readonly CurrencyCode[] = ['UGX', 'TZS', 'RWF'];

export class CurrencyError extends Error {
  constructor(message: string) { super(message); this.name = 'CurrencyError'; }
}

export function currencyOf(code: string): Currency {
  const c = (CURRENCIES as Record<string, Currency>)[code];
  if (!c) throw new CurrencyError(`Unknown currency ${code}`);
  return c;
}

/**
 * The gate. Called by `money()` on every construction, so an unsupported currency cannot
 * reach arithmetic, the ledger, or a rail adapter.
 *
 * When a second market opens: add its code to SUPPORTED. If its exponent is not 2, do the
 * exponent work FIRST — every `/ 100` and every `minimumFractionDigits: 2` in the codebase,
 * plus the display helpers and the payout minimums — and only then add it here.
 */
export function assertSupported(code: CurrencyCode): void {
  if (SUPPORTED.includes(code)) return;
  const c = currencyOf(code);
  if (c.exponent !== 2) {
    throw new CurrencyError(
      `${code} has a ${c.exponent}-decimal minor unit; this build only handles 2. ` +
      `See 10-panel-review.md §10.6.1 before enabling it.`,
    );
  }
  throw new CurrencyError(`${code} is a known currency but not enabled in this build`);
}

// ─────────────────────────────────────────────── markets

/**
 * A market is a country, and everything that varies by country lives here rather than in
 * domain code. The panel's point in 10-panel-review.md §10.6.6 applies to the last three
 * fields especially: whether the platform directs the work is a configuration decision with
 * a named owner, not an assumption buried in the assignment module.
 */
export interface Market {
  /** ISO 3166-1 alpha-2. The primary key of everything market-scoped. */
  country: string;
  currency: CurrencyCode;
  /** E.164 country calling code, for msisdn canonicalisation. */
  dialCode: string;
  /** Local mobile number pattern, after the dial code is stripped. */
  msisdnPattern: RegExp;
  timezone: string;
  locales: readonly string[];
  /** Emergency number. Hardcoding 999 was a Kenyan artefact in a safety feature. */
  emergencyNumber: string;
  /** Rails enabled here, in the order the funding UI offers them. */
  rails: readonly ('mpesa_stk' | 'mpesa_paybill' | 'wallet' | 'card' | 'bank')[];
  /** Minimum payout in MINOR units of `currency`. A KES 100 floor is not portable. */
  minPayoutMinor: number;
  /** Platform take, basis points of the runner fee. */
  feeRateBps: number;
  /** Consumer-initiated reversal window in days. 0 = the rail has none (M-Pesa). Drives the
   *  escrow release model, not just an adapter — see 10-panel-review.md §10.6.2. */
  chargebackWindowDays: number;
  /** Data residency region for this market's cell. */
  region: string;
  /** Documents that satisfy each verification tier here. Tiers gate entitlements; what
   *  proves a tier is local. */
  tierEvidence: Readonly<Record<'1' | '2' | '3', readonly string[]>>;
  /** How much the platform directs the work. Affects labour-classification exposure. */
  workDirection: 'runner_chooses' | 'platform_offers' | 'platform_assigns';
}

export const MARKETS: Readonly<Record<string, Market>> = Object.freeze({
  KE: {
    country: 'KE',
    currency: 'KES',
    dialCode: '254',
    msisdnPattern: /^(7\d{8}|1\d{8})$/,
    timezone: 'Africa/Nairobi',
    locales: ['en-KE', 'sw-KE'],
    emergencyNumber: '999',
    rails: ['mpesa_stk', 'wallet', 'mpesa_paybill'],
    minPayoutMinor: 10_000,          // KSh 100
    feeRateBps: 1200,
    chargebackWindowDays: 0,         // M-Pesa has no consumer reversal
    region: 'af-south-1',
    tierEvidence: {
      '1': ['msisdn_otp'],
      '2': ['national_id'],
      '3': ['national_id', 'conduct_certificate', 'next_of_kin'],
    },
    workDirection: 'runner_chooses',
  },
});

export function marketOf(country: string): Market {
  const m = MARKETS[country];
  if (!m) throw new CurrencyError(`No market configuration for ${country}`);
  return m;
}

export const DEFAULT_MARKET = MARKETS.KE;

/** Every enabled market's currency must be in SUPPORTED. Asserted at boot, so a market added
 *  without the exponent work cannot start. */
export function assertMarketsConsistent(): void {
  for (const m of Object.values(MARKETS)) assertSupported(m.currency);
}
