import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.visey.remoteharness',
  appName: 'Escanor',
  webDir: 'dist',
  backgroundColor: '#050505',
  server: {
    // https only: the hub token and every message travel over this connection, so plaintext hubs are refused
    // (use an https/wss hub, e.g. behind Cloudflare or a TLS proxy).
    androidScheme: 'https',
    cleartext: false,
  },
};

export default config;
