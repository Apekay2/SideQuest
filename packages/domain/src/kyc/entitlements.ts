// packages/domain/src/kyc/entitlements.ts
// Tiers and what they buy. The gateway reads these claims from the JWT and rejects
// unentitled writes without touching the database.

export type Tier = 0 | 1 | 2 | 3;

export const ENTITLEMENTS = [
  'errand.browse',      // read open errands and public profiles
  'errand.post',        // create and publish an errand
  'wallet.topup',
  'bid.place',
  'errand.accept',      // be awarded an errand carrying a card
  'batch.create',
  'payout.request',
  // Staff grants. The names are the ones 0003_rls.sql checks with app_has_ent(); a grant
  // that does not match a policy name silently grants nothing.
  'ops.read',
  'kyc.review',
  'evidence.view',
  'ledger.read',
  'location.read_cells',
  'audit.read',
  'legal_ops',          // the only entitlement that can split a frozen escrow
] as const;

/** Entitlements that only staff can hold. Never derived from a verification tier. */
export const STAFF_ENTITLEMENTS: readonly Entitlement[] = [
  'ops.read', 'kyc.review', 'evidence.view', 'ledger.read', 'location.read_cells', 'audit.read', 'legal_ops',
];

export type Entitlement = (typeof ENTITLEMENTS)[number];

const BY_TIER: Record<Tier, readonly Entitlement[]> = {
  0: ['errand.browse'],
  1: ['errand.browse', 'errand.post', 'wallet.topup'],
  2: ['errand.browse', 'errand.post', 'wallet.topup', 'bid.place', 'payout.request'],
  3: ['errand.browse', 'errand.post', 'wallet.topup', 'bid.place', 'payout.request',
      'errand.accept', 'batch.create'],
};

/** Requirements a KYC case must satisfy before it can be submitted for a given tier. */
export const TIER_REQUIREMENTS: Record<Exclude<Tier, 0>, readonly string[]> = {
  1: ['msisdn_verified'],
  2: ['id_front', 'id_back', 'selfie'],
  3: ['id_front', 'id_back', 'selfie', 'conduct_cert', 'next_of_kin', 'movement_consent'],
};

export function entitlementsFor(tier: Tier, staffGrants: readonly Entitlement[] = []): Entitlement[] {
  return [...new Set([...BY_TIER[tier], ...staffGrants])];
}

export function has(claims: readonly string[], needed: Entitlement): boolean {
  return claims.includes(needed);
}

export class TierRequiredError extends Error {
  readonly code = 'TIER_REQUIRED';
  constructor(readonly needed: Entitlement, readonly minimumTier: Tier) {
    super(`"${needed}" requires verification tier ${minimumTier}`);
    this.name = 'TierRequiredError';
  }
}

/** Lowest tier that grants an entitlement, for the "you need tier N" message in the app. */
export function minimumTierFor(needed: Entitlement): Tier {
  for (const tier of [0, 1, 2, 3] as const) {
    if (BY_TIER[tier].includes(needed)) return tier;
  }
  return 3;
}

export function assert(claims: readonly string[], needed: Entitlement): void {
  if (!has(claims, needed)) throw new TierRequiredError(needed, minimumTierFor(needed));
}
