// packages/domain/src/text/sanitize.ts
// Every string a user can put in front of another user passes through here on the way IN.
// Escaping on the way out is still the console's job (React escapes by default; the rule is
// no dangerouslySetInnerHTML anywhere in the console, enforced by an eslint rule) — but
// storing a hostile string and rendering it safely everywhere is a bet on every future
// render site being careful. This normalises at the boundary instead.
//
// Fields covered: display_name, stall/vendor names, line-item labels, decline reasons,
// dispute detail, next-of-kin name, chat messages, SMS template variables.

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// Zero-width and bidi overrides. These are how "receipt.pdf" is displayed for a file called
// "receipt<RLO>fdp.exe", and how two visually identical display names get created.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

export interface TextRule {
  max: number;
  /** Allow newlines (dispute detail) or collapse them (names, labels). */
  multiline?: boolean;
}

export class InvalidTextError extends Error {
  readonly code = 'INVALID_TEXT';
  constructor(readonly field: string, message: string) { super(message); }
}

/**
 * Normalise, strip, collapse, cap. NFC first so that a name cannot be smuggled through a
 * length check as decomposed codepoints, and so equality comparisons downstream behave.
 */
export function cleanText(field: string, raw: unknown, rule: TextRule): string {
  if (typeof raw !== 'string') throw new InvalidTextError(field, `${field} must be text`);

  let s = raw.normalize('NFC').replace(CONTROL, '').replace(INVISIBLE, '');
  s = rule.multiline
    ? s.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n')
    : s.replace(/\s+/g, ' ');
  s = s.trim();

  if (s.length === 0) throw new InvalidTextError(field, `${field} cannot be empty`);
  if (s.length > rule.max) throw new InvalidTextError(field, `${field} is too long (max ${rule.max})`);
  return s;
}

/**
 * Names get a positive character class rather than a blocklist: Kenyan names in Latin script
 * with apostrophes and hyphens (Ng'ang'a, Wanjiku-Kamau), and nothing that could be read as
 * markup, a formula, or a URL. A display name is not a place for expression.
 */
const NAME_OK = /^[\p{L}\p{M}][\p{L}\p{M}'’\-. ]{0,47}$/u;

export function cleanName(field: string, raw: unknown): string {
  const s = cleanText(field, raw, { max: 48 });
  if (!NAME_OK.test(s)) {
    throw new InvalidTextError(field, 'Use letters, spaces, apostrophes and hyphens only');
  }
  return s;
}

/**
 * Free text that another person reads: decline reasons, dispute detail, chat. Markup
 * characters are neutralised rather than rejected, because a runner writing
 * "price was 3 < 5 shillings" should not get a validation error.
 */
export function cleanProse(field: string, raw: unknown, max = 1000): string {
  const s = cleanText(field, raw, { max, multiline: true });
  return s.replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›'));
}

/**
 * Anything that lands in a CSV the ops team opens in Excel — display names, vendor names,
 * dispute reasons. A leading =, +, -, @ or tab makes the cell a formula, and
 * `=HYPERLINK(...)` in an exported dispute report is a real exfiltration path.
 */
export function csvCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/**
 * Till numbers and paybill references reach an SMS template and an M-Pesa API. Digits only,
 * so neither can be used to smuggle a second instruction.
 */
export function cleanTill(raw: unknown): string {
  if (typeof raw !== 'string' || !/^\d{5,9}$/.test(raw)) {
    throw new InvalidTextError('till_number', 'Till number must be 5 to 9 digits');
  }
  return raw;
}

/**
 * MSISDN to E.164 +254…, one canonical form. Also the value the OTP rate limiter hashes, so
 * 0722…, +254722… and 254722… cannot be used as three separate buckets against one number —
 * which is how a documented "5 per hour" limit becomes 15.
 */
export function cleanMsisdn(raw: unknown): string {
  if (typeof raw !== 'string') throw new InvalidTextError('msisdn', 'Phone number required');
  const d = raw.replace(/[\s\-()]/g, '');
  const m = /^(?:\+?254|0)(7\d{8}|1\d{8})$/.exec(d);
  if (!m) throw new InvalidTextError('msisdn', 'Enter a Kenyan mobile number');
  return `+254${m[1]}`;
}

/**
 * Presigned-upload object keys. Built server-side from an account id and a slot, never from
 * a client-supplied filename — a client filename is how you get `../` in an object key and
 * one user's selfie written over another's.
 */
const SLOTS = ['id_front', 'id_back', 'selfie', 'conduct_cert'] as const;
export type KycSlot = (typeof SLOTS)[number];

export function kycObjectKey(accountId: string, caseId: string, slot: string, ext: 'jpg' | 'png' | 'pdf'): string {
  if (!SLOTS.includes(slot as KycSlot)) throw new InvalidTextError('slot', 'Unknown document slot');
  if (!/^[0-9a-f-]{36}$/.test(accountId) || !/^[0-9a-f-]{36}$/.test(caseId)) {
    throw new InvalidTextError('id', 'Malformed identifier');
  }
  return `kyc/${accountId}/${caseId}/${slot}.${ext}`;
}

/** Content types we will presign for. An SVG upload is a stored-XSS vector on any origin
 *  that serves it inline, so it is not on the list and never should be. */
export const UPLOAD_CONTENT_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;

export function assertUploadContentType(ct: unknown): (typeof UPLOAD_CONTENT_TYPES)[number] {
  if (typeof ct !== 'string' || !UPLOAD_CONTENT_TYPES.includes(ct as any)) {
    throw new InvalidTextError('content_type', 'Upload a JPEG, PNG or PDF');
  }
  return ct as (typeof UPLOAD_CONTENT_TYPES)[number];
}
