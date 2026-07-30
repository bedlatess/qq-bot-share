import { resolve } from 'node:path';

function integer(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function requiredSecret(name: string, fallback: string): string {
  const value = process.env[name] || fallback;
  if (process.env.NODE_ENV === 'production' && value === fallback) {
    throw new Error(`${name} must be configured in production`);
  }
  return value;
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const root = resolve(process.cwd());
  return {
    host: process.env.HOST || '0.0.0.0',
    port: integer('PORT', 17866),
    dataDir: resolve(process.env.DATA_DIR || resolve(root, 'data')),
    publicDir: resolve(process.env.PUBLIC_DIR || resolve(root, 'apps/control/public')),
    agentBundlePath: resolve(process.env.AGENT_BUNDLE_PATH || resolve(root, 'puff-agent-update.tar.gz')),
    publicUrl: process.env.PUBLIC_URL || 'http://127.0.0.1:17866',
    adminEmail: (process.env.ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase(),
    adminPassword: process.env.ADMIN_PASSWORD || 'change-this-password',
    sessionSecret: requiredSecret('SESSION_SECRET', 'dev-session-secret-change-me-32-chars'),
    masterKey: requiredSecret('MASTER_KEY', 'dev-master-key-change-me-32-chars'),
    storageLimitBytes: integer('STORAGE_LIMIT_BYTES', 5 * 1024 * 1024 * 1024),
    logLevel: process.env.LOG_LEVEL || 'info',
    isProduction: process.env.NODE_ENV === 'production',
  };
}
