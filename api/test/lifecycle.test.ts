import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { buildApp } from '../src/app';
import { readConfig } from '../src/config';
import { readMigrations } from '../src/migrations';
import { isolatedPostgres } from './postgres';

const exec = promisify(execFile);

test('documented CLI migrations and real HTTP startup work against an isolated database', { timeout: 240_000 }, async () => {
  const database = await isolatedPostgres();
  const env = { ...process.env, DATABASE_URL: database.connectionString };
  const app = buildApp(database.pool, await readMigrations(), { logger: false });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { stdout } = await exec(process.execPath, [path.resolve(__dirname, '../src/migrate.js')], { env });
      assert.match(stdout, /migrations_complete/);
      assert(!stdout.includes(database.connectionString));
    }
    const config = readConfig({ ...env, PORT: '0' });
    const address = await app.listen({ host: config.host, port: config.port });
    const response = await fetch(`${address}/api/health/ready`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ready' });
    const { rows } = await database.pool.query('SELECT count(*)::int AS count FROM users');
    assert.equal(rows[0]?.['count'], 0, 'ordinary startup must not seed an account');
  } finally {
    await app.close();
    await database.close();
  }
});
