export class ConfigurationError extends Error {
  constructor(readonly field: string, reason: string) {
    super(`${field}: ${reason}`);
  }
}

export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  /** True only when every request reaches the API through a trusted reverse proxy that sets X-Forwarded-For. */
  trustProxy: boolean;
}

export function readConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = environment['DATABASE_URL'];
  if (!databaseUrl) throw new ConfigurationError('DATABASE_URL', 'is required');
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new ConfigurationError('DATABASE_URL', 'must be a PostgreSQL connection URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
    throw new ConfigurationError('DATABASE_URL', 'must identify a PostgreSQL host and database');
  }
  const rawPort = environment['PORT'] ?? '3000';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigurationError('PORT', 'must be an integer from 0 to 65535');
  }
  const rawProxy = environment['TRUST_PROXY'] ?? 'false';
  if (rawProxy !== 'true' && rawProxy !== 'false') throw new ConfigurationError('TRUST_PROXY', 'must be true or false');
  return { databaseUrl, host: environment['HOST'] || '127.0.0.1', port, trustProxy: rawProxy === 'true' };
}
