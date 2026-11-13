import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { buildApp } from '../src/app';
import { ConfigurationError, readConfig } from '../src/config';
import { createPool } from '../src/database';
import { loggerOptions, safeDiagnostic } from '../src/errors';
import { migrate, readMigrations } from '../src/migrations';
import { isolatedPostgres } from './postgres';

test('configuration diagnostics identify fields without exposing their values', () => {
  assert.throws(() => readConfig({}), /DATABASE_URL: is required/);
  assert.throws(() => readConfig({ DATABASE_URL: 'private-value' }), /must be a PostgreSQL connection URL/);
  assert.throws(() => readConfig({ DATABASE_URL: 'http://user:secret@example.com/db' }), ConfigurationError);
  assert.throws(() => readConfig({ DATABASE_URL: 'postgres://localhost/db', PORT: 'secret' }), /PORT: must be an integer/);
  assert.deepEqual(readConfig({ DATABASE_URL: 'postgres://localhost/db' }), {
    databaseUrl: 'postgres://localhost/db', host: '127.0.0.1', port: 3000, trustProxy: false,
  });
  assert.deepEqual(safeDiagnostic(new Error('password=private-value')), { category: 'dependency', code: 'INTERNAL_ERROR' });
});

test('API readiness verifies migrated PostgreSQL and errors/logs redact inputs', { timeout: 240_000 }, async () => {
  const database = await isolatedPostgres();
  const migrations = await readMigrations();
  const logs: string[] = [];
  const stream = new Writable({ write: (chunk, _encoding, done) => { logs.push(String(chunk)); done(); } });
  const app = buildApp(database.pool, migrations, { logger: { ...loggerOptions, stream } });
  app.post('/test/error', async () => { throw new Error('password=private-value'); });
  try {
    assert.equal((await app.inject('/api/health/live')).statusCode, 200);
    const unready = await app.inject('/api/health/ready');
    assert.equal(unready.statusCode, 503);
    assert.equal(unready.json().error.code, 'DEPENDENCY_UNAVAILABLE');
    await migrate(database.pool, migrations);
    assert.equal((await app.inject('/api/health/ready')).statusCode, 200);
    const failed = await app.inject({
      method: 'POST', url: '/test/error?secret=private-value',
      headers: { authorization: 'Bearer private-value', cookie: 'session=private-value' },
      payload: { password: 'private-value' },
    });
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.json().error.code, 'INTERNAL_ERROR');
    assert.equal(failed.headers['cache-control'], 'no-store');
    assert(!failed.body.includes('private-value'));
    assert(!logs.join('').includes('private-value'));
    await database.pool.query('DROP TABLE schema_migrations');
    assert.equal((await app.inject('/api/health/ready')).statusCode, 503);
  } finally {
    await app.close();
    await database.close();
  }
});

test('dependency connection failures are explicit, not successful empty responses', async () => {
  const pool = createPool('postgresql://test:private-value@127.0.0.1:1/unavailable');
  const app = buildApp(pool, await readMigrations(), { logger: false });
  try {
    const result = await app.inject('/api/health/ready');
    assert.equal(result.statusCode, 503);
    assert(!result.body.includes('private-value'));
  } finally {
    await app.close();
    await pool.end();
  }
});
