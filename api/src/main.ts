import Fastify from 'fastify';
import { buildApp } from './app';
import { readConfig } from './config';
import { createPool } from './database';
import { loggerOptions, safeDiagnostic } from './errors';
import { readMigrations } from './migrations';
import { ObjectStorage, readStorageConfig } from './object-storage';
import { startAttachmentCleanup } from './attachment-cleanup';

async function main(): Promise<void> {
  const config = readConfig();
  const migrations = await readMigrations();
  const storage = new ObjectStorage(readStorageConfig());
  const pool = createPool(config.databaseUrl);
  const app = buildApp(pool, migrations, { trustProxy: config.trustProxy }, undefined, storage);
  let cleanup: ReturnType<typeof startAttachmentCleanup> | undefined;
  app.addHook('onClose', async () => { await cleanup?.stop(); storage.client.destroy(); await pool.end(); });
  const close = async () => {
    try {
      await app.close();
    } catch (error) {
      app.log.error({ diagnostic: safeDiagnostic(error) }, 'shutdown_failed');
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  try {
    await app.listen({ host: config.host, port: config.port });
    cleanup = startAttachmentCleanup(pool, storage, app.log);
  } catch (error) {
    await app.close();
    throw error;
  }
}

void main().catch((error: unknown) => {
  const logger = Fastify({ logger: loggerOptions }).log;
  logger.error({ diagnostic: safeDiagnostic(error) }, 'startup_failed');
  process.exitCode = 1;
});
