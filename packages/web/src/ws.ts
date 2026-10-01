import type { HubToBrowserMessage } from '@remote-harness/shared';
import { getToken, getHubUrl } from './api';

type Handler = (msg: HubToBrowserMessage) => void;

const RECONNECT_DELAY_MS = 2000;

export class HubSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private stopped = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  connect(): void {
    this.stopped = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const token = getToken();
    if (!token) return;
    const hub = getHubUrl();
    const base = hub ? hub.replace(/^http/, 'ws') : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
    const ws = new WebSocket(`${base}/ws`, ['escanor.hub.v1', `escanor.auth.${token}`]);
    this.ws = ws;

    // Keeps the connection alive through Cloudflare's idle timeout; the hub answers 'pong' itself.
    ws.onopen = () => {
      if (this.stopped || this.ws !== ws) return;
      this.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 25_000);
    };
    ws.onmessage = (evt) => {
      if (this.stopped || this.ws !== ws) return;
      try {
        const msg = JSON.parse(evt.data) as HubToBrowserMessage;
        for (const h of this.handlers) h(msg);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (!this.stopped) setTimeout(() => { if (!this.stopped) this.connect(); }, RECONNECT_DELAY_MS);
    };
  }

  subscribe(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ws?.close();
    this.ws = null;
  }
}

export const hubSocket = new HubSocket();
