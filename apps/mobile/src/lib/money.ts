// Display only; never parse back. KES carries two decimals (packages/domain money/currency.ts);
// whole shillings print without them, as the prototype does ("KSh 380").
export function kes(minor: number | null | undefined, locale = 'en-KE'): string {
  const v = minor ?? 0;
  const whole = v % 100 === 0;
  const n = new Intl.NumberFormat(locale, { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(v / 100);
  return `KSh ${n}`;
}

/** Parse a shilling amount typed by a person into minor units. Returns null if not a number. */
export function toMinor(input: string): number | null {
  const n = Number(input.replace(/[,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}
