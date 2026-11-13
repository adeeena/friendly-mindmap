import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';
import { createPool } from '../src/database';

const exec = promisify(execFile);

export async function isolatedPostgres(): Promise<{ pool: Pool; connectionString: string; close: () => Promise<void> }> {
  const name = `friendly-mindmap-test-${randomUUID()}`;
  const password = randomBytes(32).toString('hex');
  await exec('docker', [
    'run', '--rm', '--detach', '--name', name,
    '--publish', '127.0.0.1::5432',
    '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_USER=mindmap', '--env', 'POSTGRES_DB=mindmap',
    'postgres:17-alpine',
  ], { env: { ...process.env, POSTGRES_PASSWORD: password }, timeout: 180_000 });
  let pool: Pool | undefined;
  try {
    const { stdout } = await exec('docker', ['port', name, '5432/tcp']);
    const port = stdout.trim().split(':').at(-1);
    if (!port || !/^\d+$/.test(port)) throw new Error('Test PostgreSQL port was not assigned');
    const connectionString = `postgresql://mindmap:${password}@127.0.0.1:${port}/mindmap`;
    pool = createPool(connectionString);
    // Container startup can be slow when the Docker host is busy.
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        await pool.query('SELECT 1');
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await setTimeout(200);
      }
    }
    const database = pool;
    return {
      pool: database,
      connectionString,
      close: async () => {
        try {
          await database.end();
        } finally {
          await exec('docker', ['stop', name], { timeout: 30_000 });
        }
      },
    };
  } catch (error) {
    try {
      await pool?.end();
    } finally {
      await exec('docker', ['stop', name], { timeout: 30_000 });
    }
    throw error;
  }
}
