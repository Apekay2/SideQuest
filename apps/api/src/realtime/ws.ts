// apps/api/src/realtime/ws.ts
// WebSocket at /ws, authenticated with the access token (04-api.md §Realtime). Server-push
// only; every event is also derivable by polling, so a dropped socket degrades to polling.
//
// One Redis subscriber per process, channel u:{accountId}. Any replica's app.publish reaches
// a socket held by any other replica, and the worker publishes on the same channels.

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { jwtVerify } from 'jose';
import { metrics } from '@sidequest/observability';

export default fp(async function realtime(app: FastifyInstance) {
  const { redisSub, cfg } = app.deps;
  const key = new TextEncoder().encode(cfg.JWT_SECRET);
  const sockets = new Map<string, Set<WebSocket>>();

  redisSub.on('message', (channel: string, message: string) => {
    const set = sockets.get(channel.slice(2));
    if (!set) return;
    for (const ws of set) if (ws.readyState === 1) ws.send(message);
  });

  app.get('/ws', { websocket: true }, async (socket, req) => {
    // Browsers cannot set headers on a WebSocket, so the token rides the first message rather
    // than the URL: a token in a query string ends up in proxy access logs.
    let accountId: string | null = null;
    const timer = setTimeout(() => socket.close(4401, 'auth timeout'), 5000);

    socket.on('message', async (raw: Buffer) => {
      if (accountId) return;              // server-push only after auth
      clearTimeout(timer);
      try {
        const { token } = JSON.parse(raw.toString()) as { token?: string };
        const { payload } = await jwtVerify(String(token), key, { issuer: 'sidequest-api', algorithms: ['HS256'] });
        accountId = String(payload.sub);
      } catch {
        socket.close(4401, 'unauthenticated');
        return;
      }
      let set = sockets.get(accountId);
      if (!set) {
        set = new Set();
        sockets.set(accountId, set);
        await redisSub.subscribe(`u:${accountId}`);
      }
      set.add(socket);
      metrics.gauge('ws.connections', [...sockets.values()].reduce((n, s) => n + s.size, 0));
      socket.send(JSON.stringify({ event: 'ready', data: {} }));
    });

    socket.on('close', async () => {
      clearTimeout(timer);
      if (!accountId) return;
      const set = sockets.get(accountId);
      set?.delete(socket);
      if (set && set.size === 0) {
        sockets.delete(accountId);
        await redisSub.unsubscribe(`u:${accountId}`).catch(() => undefined);
      }
    });
    void req;
  });
});
