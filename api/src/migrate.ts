import Fastify from 'fastify';
import { readConfig } from './config';
import { createPool } from './database';
import { loggerOptions, safeDiagnostic } from './errors';
import { migrate, readMigrations } from './migrations';

const logger = Fastify({ logger: loggerOptions }).log;

async function main(): Promise<void> {
  const config = readConfig();
  const pool = createPool(config.databaseUrl);
  pool.on('error', (error) => logger.error({ diagnostic: safeDiagnostic(error) }, 'database_pool_error'));
  try {
    await migrate(pool, await readMigrations());
    logger.info('migrations_complete');
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  logger.error({ diagnostic: safeDiagnostic(error) }, 'migration_failed');
  process.exitCode = 1;
});
