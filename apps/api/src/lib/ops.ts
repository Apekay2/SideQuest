// apps/api/src/lib/ops.ts
// Shared by every /ops route: the gate (source allowlist → staff role → entitlement), the
// in-transaction audit row, and entitlement checks for parts of a response.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Tx } from '@sidequest/db';
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
