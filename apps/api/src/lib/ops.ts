// apps/api/src/lib/ops.ts
// Shared by every /ops route: the gate (source allowlist → staff role → entitlement), the
// in-transaction audit row, and entitlement checks for parts of a response.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withActor, type Tx } from '@sidequest/db';
import { ipInCidrs } from '@sidequest/adapters';
import { AppError } from '../plugins/errors.js';

export function opsGate(app: FastifyInstance) {
  const { cfg } = app.deps;
  return (ent: string) => [
    async (req: FastifyRequest) => {
      if (cfg.OPS_IP_ALLOWLIST.length > 0 && !ipInCidrs(req.trustedIp, cfg.OPS_IP_ALLOWLIST)) {
        throw new AppError(403, 'FORBIDDEN', 'Not reachable from this network');
      }
    },
    app.requireRole('staff'),
    app.requireEntitlement(ent),
    // The token's grants are up to 15 minutes old. For the accounts that can rule disputes,
    // void cards and approve identities, that was 15 minutes in which a suspended officer, or
    // one whose grant had just been removed, could keep acting. Every /ops request now re-reads
    // the session and the account: one indexed lookup each.
    app.assertSessionIntegrity,
    async (req: FastifyRequest) => {
      const [a] = await withActor(app.deps.sql, req.actor!, (tx) => tx<{ role: string; suspended_at: Date | null; staff_grants: string[] }[]>`
        SELECT role, suspended_at, staff_grants FROM account WHERE id = ${req.actor!.id}`);
      if (!a || a.role !== 'staff' || a.suspended_at) throw new AppError(401, 'SESSION_REVOKED', 'Sign in again');
      if (!a.staff_grants.includes(ent)) throw new AppError(403, 'FORBIDDEN', 'This access was removed. Sign in again to refresh it.');
    },
  ];
}

/** Whether the signed-in officer holds an entitlement (for optional parts of a response). */
export const holds = (req: FastifyRequest, ent: string) => req.actor!.entitlements.includes(ent);

/** One audit row, in the same transaction as what it records. */
export const opsAudit = (req: FastifyRequest, tx: Tx, action: string, subject: string, meta?: Record<string, unknown>) => tx`
  INSERT INTO audit_log (actor_id, action, subject, meta)
  VALUES (${req.actor!.id}, ${action}, ${subject}, ${tx.json({ ...(meta ?? {}), ip: req.trustedIp, request_id: req.id } as never)})`;

/** "…123": enough for an officer to confirm a number with its owner, no more. */
export const maskMsisdn = (msisdn: string | null) => (msisdn ? `…${msisdn.slice(-3)}` : null);
