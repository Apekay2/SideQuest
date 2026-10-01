// apps/mobile/src/lib/realtime.ts
// The WebSocket is an accelerator, never a dependency (05-ui-architecture §5.4): every event
// invalidates react-query keys that the screens also poll, so a dropped socket costs the user
// seconds, not a stuck screen.

import type { QueryClient } from '@tanstack/react-query';
import { API_URL, refresh } from './api';
import { useSession } from './session';

// Server close codes (apps/api/src/realtime/ws.ts): the socket is bound to the session.
const EXPIRED = 4402;
const AUTH_CLOSES = new Set([4401, 4402, 4403]);

type Listener = (event: string, data: Record<string, unknown>) => void;
const listeners = new Set<Listener>();

export function onRealtime(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function startRealtime(qc: QueryClient): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let backoff = 1000;

  const connect = () => {
    const token = useSession.getState().access;
    if (stopped || !token) return;
    ws = new WebSocket(API_URL.replace(/^http/, 'ws') + '/ws');
    // The token rides the first message, never the URL: URLs end up in proxy logs.
    ws.onopen = () => { ws?.send(JSON.stringify({ token })); backoff = 1000; };
    ws.onmessage = (m) => {
      let msg: { event: string; data: Record<string, unknown> };
      try { msg = JSON.parse(String(m.data)); } catch { return; }
      const errandId = typeof msg.data?.errand_id === 'string' ? msg.data.errand_id : null;
      if (errandId) qc.invalidateQueries({ queryKey: ['errand', errandId] });
      if (/^(errand|bid|stall|tranche|reimbursement|feed|offer)\./.test(msg.event)) qc.invalidateQueries({ queryKey: ['errands'] });
      if (/^(payment|payout|errand\.settled|withdraw)/.test(msg.event)) {
        qc.invalidateQueries({ queryKey: ['wallet'] });
        qc.invalidateQueries({ queryKey: ['earnings'] });
      }
      if (msg.event === 'feed.new') qc.invalidateQueries({ queryKey: ['feed'] });
      if (msg.event === 'message.new' && errandId) qc.invalidateQueries({ queryKey: ['messages', errandId] });
      for (const l of listeners) l(msg.event, msg.data ?? {});
    };
    ws.onclose = (e) => {
      ws = null;
      if (stopped) return;
      // The server closed on the session, not the network: reconnecting with the same token
      // would only be refused again. Expiry → refresh (a new access token reconnects via the
      // subscription below); revoked or refused → wait for the next sign-in.
      if (AUTH_CLOSES.has(e.code)) {
        if (e.code === EXPIRED) void refresh();
        return;
      }
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };
    ws.onerror = () => ws?.close();
  };
  connect();
  // A new access token: drop the old socket (its onclose reconnects) or, if none is open
  // because the last one closed on the session, connect now.
  const unsub = useSession.subscribe((s, prev) => {
    if (!s.access || s.access === prev.access) return;
    if (ws) ws.close(); else connect();
  });
  return () => { stopped = true; unsub(); ws?.close(); };
}
