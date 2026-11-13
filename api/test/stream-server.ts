import { buildApp } from '../src/app';
import { readAuthConfig } from '../src/auth';
import { readConfig } from '../src/config';
import { createPool } from '../src/database';
import { safeDiagnostic } from '../src/errors';
import { readMigrations } from '../src/migrations';
import { ObjectStorage, readStorageConfig } from '../src/object-storage';

async function main() {
  const pool = createPool(readConfig().databaseUrl);
  const storage = new ObjectStorage(readStorageConfig());
  const app = buildApp(pool, await readMigrations(), { logger: false }, readAuthConfig(), storage);
  app.addHook('onClose', async () => { storage.client.destroy(); await pool.end(); });
  let baseline = process.memoryUsage();
  let maxRss = baseline.rss;
  let maxExternal = baseline.external;
  const measure = () => {
    const usage = process.memoryUsage();
    maxRss = Math.max(maxRss, usage.rss);
    maxExternal = Math.max(maxExternal, usage.external);
  };
  const timer = setInterval(measure, 10);
  const close = async () => {
    clearInterval(timer);
    await app.close();
    process.disconnect();
  };
  process.on('SIGTERM', () => { void close(); });
  process.on('message', (message: unknown) => {
    if (message === 'measure') {
      baseline = process.memoryUsage();
      maxRss = baseline.rss;
      maxExternal = baseline.external;
      process.send?.({ type: 'measuring' });
    } else if (message === 'report') {
      measure();
      process.send?.({ type: 'report', rssGrowth: maxRss - baseline.rss, externalGrowth: maxExternal - baseline.external });
    } else if (message === 'shutdown') {
      void close();
    }
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  process.send?.({ type: 'ready', address });
}

void main().catch((error: unknown) => {
  process.send?.({ type: 'failed', diagnostic: safeDiagnostic(error) });
  process.exitCode = 1;
});
