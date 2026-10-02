import { useCallback, useEffect, useRef, useState } from 'react';
import { escanor } from '../client';
import { ComputerClient, type PairedComputer, type Route } from './lib/client';
import type { ClientMsg, ServerMsg } from './lib/protocol';

export type LinkState = 'connecting' | 'online' | 'offline';

/** A live link to one paired computer: connects the best way available, reconnects, and exposes requests and pushes. */
export function useComputer(computer: PairedComputer) {
  const clientRef = useRef<ComputerClient | null>(null);
  const [state, setState] = useState<LinkState>('connecting');
  const [route, setRoute] = useState<Route | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pushListeners = useRef(new Set<(m: ServerMsg) => void>());

  const connect = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    setState('connecting');
    setError(null);
    try {
      await client.connect();
      setState('online');
      await client.subscribe(['events']).catch(() => undefined);
    } catch (e) {
      setState('offline');
      setError(e instanceof Error ? e.message : 'Could not reach this computer.');
    }
  }, []);

  useEffect(() => {
    const client = new ComputerClient(computer, { relay: ({ agentId, deviceId, sealed }) => escanor.sendToComputer(agentId, deviceId, sealed) });
    clientRef.current = client;
    const offRoute = client.onRoute(setRoute);
    const offPush = client.onPush((m) => pushListeners.current.forEach((l) => l(m)));
    void connect();
    return () => {
      offRoute();
      offPush();
      client.close();
      clientRef.current = null;
    };
  }, [computer, connect]);

  const request = useCallback(async (msg: ClientMsg): Promise<ServerMsg[]> => {
    const client = clientRef.current;
    if (!client) throw new Error('Not connected.');
    try {
      const out = await client.request(msg);
      setState('online');
      return out;
    } catch (e) {
      setState('offline');
      setError(e instanceof Error ? e.message : 'The computer did not answer.');
      throw e;
    }
  }, []);

  const onPush = useCallback((cb: (m: ServerMsg) => void) => {
    pushListeners.current.add(cb);
    return () => void pushListeners.current.delete(cb);
  }, []);

  return { state, route, error, request, onPush, reconnect: connect };
}
