import { resolve } from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT || 8787),
  hubAgentToken: required('HUB_AGENT_TOKEN'),
  appPassword: required('APP_PASSWORD'),
  dataDir: resolve(process.env.DATA_DIR || './data'),
  escanorApiUrl: (process.env.ESCANOR_API_URL || 'https://api.escanor.in/api/v1').replace(/\/+$/, ''),
  allowedEmails: (process.env.HUB_ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  webDist: resolve(process.env.WEB_DIST || '../web/dist'),
};
