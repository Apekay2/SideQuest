// Display helpers shared by every console page. Pure; no server or browser APIs.

/** "1,190" from 119000 cents. Shillings only: the console never shows cents that do not exist. */
export function ksh(cents: number): string {
  const whole = cents / 100;
  return whole.toLocaleString('en-KE', { minimumFractionDigits: Number.isInteger(whole) ? 0 : 2, maximumFractionDigits: 2 });
}

/** "35 min", "4 h", "1 d": how long something has waited, at the grain an officer acts on. */
export function waited(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86_400)} d`;
}

/** A short, stable, speakable reference for a row: "DSP-3F9A1C". Not a secret, not an id. */
export function ref(prefix: 'KYC' | 'DSP' | 'ERR', id: string): string {
  return `${prefix}-${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

/** "22 Aug 09:14" in Nairobi time, whatever the server's zone. */
export function when(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleString('en-GB', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    .replace(',', '');
}

export const DISPUTE_REASON: Record<string, string> = {
  goods_wrong: 'Goods not what was asked for',
  goods_missing: 'Goods missing',
  overcharged: 'Overcharged',
  no_show: 'Runner stopped responding',
  safety: 'Safety concern',
  other: 'Other',
};

export const ERRAND_KIND: Record<string, string> = {
  market_run: 'Market run',
  pickup_dropoff: 'Pick up & drop off',
  queue: 'Queue',
  documents: 'Documents',
};

export const label = (map: Record<string, string>, key: string) => map[key] ?? key.replace(/_/g, ' ');
