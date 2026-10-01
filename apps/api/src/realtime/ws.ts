// apps/api/src/realtime/ws.ts
// WebSocket at /ws, authenticated with the access token (04-api.md §Realtime). Server-push
// only; every event is also derivable by polling, so a dropped socket degrades to polling.
//
// One Redis subscriber per process, channel u:{accountId}. Any replica's app.publish reaches
// a socket held by any other replica, and the worker publishes on the same channels.
//
// A socket is only as good as the session behind it. Checking the token's signature once is
// not enough: the socket outlives the token, and it carries the counterpart's live location.
// So the session row is checked at sign-in and every minute after, and the socket is closed
// when the access token expires; the client reconnects with its refreshed token.

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { metrics } from '@sidequest/observability';
import { verifyAccess, sessionLive } from '../plugins/auth.js';
import type { Actor } from '../types.js';

export const WS_REVALIDATE_MS = 60_000;
/** Close codes the client acts on: re-authenticate with a fresh token, don't hammer. */
export const WS_CLOSE = { unauthenticated: 4401, expired: 4402, revoked: 4403 } as const;

export default fp(async function realtime(app: FastifyInstance) {
  const { redisSub, cfg, sql } = app.deps;
  const key = new TextEncoder().encode(cfg.JWT_SECRET);
  const sockets = new Map<string, Set<WebSocket>>();

  redisSub.on('message', (channel: string, message: string) => {
    const set = sockets.get(channel.slice(2));
    if (!set) return;
    for (const ws of set) if (ws.readyState === 1) ws.send(message);
  });

  const count = () => metrics.gauge('ws.connections', [...sockets.values()].reduce((n, s) => n + s.size, 0));

  app.get('/ws', { websocket: true }, async (socket) => {
    // Browsers cannot set headers on a WebSocket, so the token rides the first message rather
    // than the URL: a token in a query string ends up in proxy access logs.
    let actor: Actor | null = null;
    let authing = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const authTimeout = setTimeout(() => socket.close(WS_CLOSE.unauthenticated, 'auth timeout'), 5000);

    socket.on('message', async (raw: Buffer) => {
      if (actor || authing) return;      // server-push only; one sign-in per socket
      authing = true;
      clearTimeout(authTimeout);
      let exp: number;
      try {
        const { token } = JSON.parse(raw.toString()) as { token?: string };
        const v = await verifyAccess(key, String(token));
        if (!(await sessionLive(sql, v.actor))) throw new Error('session not live');
        actor = v.actor; exp = v.exp;
      } catch {
        socket.close(WS_CLOSE.unauthenticated, 'unauthenticated');
        return;
      }
      const id = actor.id;
      let set = sockets.get(id);
      if (!set) {
        set = new Set();
        sockets.set(id, set);
        await redisSub.subscribe(`u:${id}`);
      }
      set.add(socket);
      count();

      timers.push(setTimeout(() => socket.close(WS_CLOSE.expired, 'token expired'), Math.max(0, exp * 1000 - Date.now())));
      const recheck = setInterval(async () => {
        const live = await sessionLive(sql, actor!).catch(() => true);   // a DB blip is not a revocation
        if (!live) socket.close(WS_CLOSE.revoked, 'session revoked');
      }, WS_REVALIDATE_MS);
      timers.push(recheck as unknown as ReturnType<typeof setTimeout>);
      socket.send(JSON.stringify({ event: 'ready', data: {} }));
    });

    socket.on('close', async () => {
      clearTimeout(authTimeout);
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      if (!actor) return;
      const set = sockets.get(actor.id);
      set?.delete(socket);
      if (set && set.size === 0) {
        sockets.delete(actor.id);
        await redisSub.unsubscribe(`u:${actor.id}`).catch(() => undefined);
      }
      count();
    });
  });
});
