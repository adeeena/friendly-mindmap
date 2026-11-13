import Fastify from 'fastify';
import { readConfig, ConfigurationError } from './config';
import { createPool } from './database';
import { loggerOptions, safeDiagnostic } from './errors';
import { bootstrapAdmin, changePassword, readAccountPassword } from './provisioning';

const logger = Fastify({ logger: loggerOptions }).log;

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!['bootstrap', 'password'].includes(command ?? '')) {
    throw new ConfigurationError('command', 'use bootstrap or password');
  }
  const config = readConfig();
  const pool = createPool(config.databaseUrl);
  pool.on('error', (error) => logger.error({ diagnostic: safeDiagnostic(error) }, 'database_pool_error'));
  try {
    const username = process.env['ACCOUNT_USERNAME'] ?? (command === 'bootstrap' ? 'adena' : '');
    if (!username) throw new ConfigurationError('ACCOUNT_USERNAME', 'is required for password changes');
    const password = await readAccountPassword(process.env);
    if (command === 'bootstrap') {
      const { created } = await bootstrapAdmin(pool, username, password);
      logger.info({ created }, 'development_bootstrap_complete');
    } else {
      await changePassword(pool, username, password);
      logger.info('password_changed_sessions_revoked');
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  logger.error({ diagnostic: safeDiagnostic(error) }, 'account_operation_failed');
  process.exitCode = 1;
});
