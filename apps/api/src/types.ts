// apps/api/src/types.ts
// Everything the server decorates onto Fastify, declared once.

import type { Redis } from 'ioredis';
import type { Sql, Tx, ScopeOptions } from '@sidequest/db';
import type { Config } from '@sidequest/config';
import type { StoragePort, LocalStorage, SmsPort } from '@sidequest/adapters';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Limit } from './plugins/rate-limit.js';

export interface Actor {
  id: string;
  role: 'requester' | 'runner' | 'staff';
  tier: 0 | 1 | 2 | 3;
  entitlements: readonly string[];
  sessionId: string;
  /** Accepted the current terms and privacy notice (claim `lg`); staff are not asked. */
  legal: boolean;
}

export interface Deps {
  cfg: Config;
  sql: Sql;
  opsSql: Sql;
  redis: Redis;
  /** A second connection for SUBSCRIBE; a subscribed ioredis client can issue nothing else. */
  redisSub: Redis;
  storage: StoragePort;
  localStorage: LocalStorage | null;
  sms: SmsPort;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: Deps;
    /** Run `fn` in a transaction bound to the request's actor. The only sanctioned DB path. */
    tx<T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>, opts?: ScopeOptions): Promise<T>;
    /** The same, on the sidequest_ops pool, for /ops routes. */
    opsTx<T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>): Promise<T>;
    limit(...limits: Limit[]): preHandlerAsyncHookHandler;
    idempotent: preHandlerAsyncHookHandler;
    requireAuth: preHandlerAsyncHookHandler;
    requireRole(role: Actor['role']): preHandlerAsyncHookHandler;
    requireEntitlement(ent: string): preHandlerAsyncHookHandler;
    assertSessionIntegrity: preHandlerAsyncHookHandler;
    audit(req: FastifyRequest, entry: { action: string; subject: string; meta?: Record<string, unknown> }, tx?: Tx): Promise<void>;
    publish(accountId: string, event: string, data: Record<string, unknown>): Promise<void>;
    setRefreshCookie(reply: FastifyReply, token: string): void;
    clearRefreshCookie(reply: FastifyReply): void;
  }
  interface FastifyRequest {
    actor?: Actor;
    trustedIp: string;
    hashedMsisdn?: string;
    cspNonce?: string;
    idempotency?: { key: string; hash: string; replayed: boolean };
  }
  interface FastifyContextConfig {
    money?: boolean;
  }
}
