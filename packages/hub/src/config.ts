import { resolve } from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  if (v.length < 24) throw new Error(`${name} must be a random secret of at least 24 characters`);
  return v;
}

export const config = {
  port: Number(process.env.PORT || 8787),
  hubAgentToken: required('HUB_AGENT_TOKEN'),
  appPassword: required('APP_PASSWORD'),
  // Optional. Set it to let an operator create isolated tenants on this hub (see admin.ts).
  hubAdminToken: process.env.HUB_ADMIN_TOKEN || '',
  // The shortest life a machine credential may be given. 60 s in real use; tests lower it to watch one expire.
  machineMinTtlSeconds: Number(process.env.HUB_MACHINE_MIN_TTL_SECONDS || 60),
  dataDir: resolve(process.env.DATA_DIR || './data'),
  webDist: resolve(process.env.WEB_DIST || '../web/dist'),
};
