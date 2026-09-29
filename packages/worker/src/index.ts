import { Hub } from './hub';

export { Hub };

export interface Env {
  HUB: DurableObjectNamespace;
  ASSETS: Fetcher;
  HUB_AGENT_TOKEN: string;
  APP_PASSWORD: string;
  ESCANOR_API_URL?: string;
  HUB_ALLOWED_EMAILS?: string;
}

// Everything stateful lives in one Durable Object so that agent sockets, browser sockets
// and the database share a single instance — the Worker just routes to it.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/') || pathname === '/ws' || pathname === '/agent') {
      return env.HUB.get(env.HUB.idFromName('hub')).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
