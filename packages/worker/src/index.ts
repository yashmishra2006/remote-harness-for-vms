import { Hub } from './hub';

export { Hub };

export interface Env {
  HUB: DurableObjectNamespace;
  ASSETS: Fetcher;
  HUB_AGENT_TOKEN: string;
  APP_PASSWORD: string;
  // Optional, off unless set to "1": allow a loopback / private-network MCP URL (dev); accept the legacy /ws?token= form.
  HUB_MCP_ALLOW_PRIVATE?: string;
  HUB_ALLOW_QUERY_TOKEN?: string;
}

const MAX_BODY_UNAUTHENTICATED = 16 * 1024;
const MAX_BODY_AUTHENTICATED = 20 * 1024 * 1024;

// Everything stateful lives in one Durable Object so that agent sockets, browser sockets
// and the database share a single instance — the Worker just routes to it.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/') || pathname === '/ws' || pathname === '/agent') {
      // Refuse an oversized or unauthenticated upload here, before it is streamed on to the Durable Object: answering from
      // inside the object while a large body is still arriving makes the runtime fail the request, and it would wake the
      // object for nothing. The object re-checks everything itself.
      if (pathname.startsWith('/api/') && request.method !== 'GET' && request.method !== 'OPTIONS' && request.method !== 'DELETE') {
        const length = Number(request.headers.get('content-length') ?? 0);
        const hasBearer = (request.headers.get('authorization') ?? '').startsWith('Bearer ');
        if (length > MAX_BODY_AUTHENTICATED || (!hasBearer && length > MAX_BODY_UNAUTHENTICATED)) {
          const status = !hasBearer && pathname !== '/api/login' ? 401 : 413;
          return new Response(JSON.stringify({ error: status === 401 ? 'Unauthorized' : 'Request body too large' }), {
            status,
            headers: { 'content-type': 'application/json', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' },
          });
        }
      }
      return env.HUB.get(env.HUB.idFromName('hub')).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
