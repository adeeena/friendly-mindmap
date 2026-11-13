import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { buildApp } from '../src/app';
import { bootstrapAdmin, readAccountPassword } from '../src/provisioning';
import { migrate, readMigrations } from '../src/migrations';
import { isolatedPostgres } from './postgres';

const exec = promisify(execFile);

test('explicit bootstrap does not reset passwords and rotation revokes sessions', { timeout: 240_000 }, async () => {
  const database = await isolatedPostgres();
  const migrations = await readMigrations();
  const origin = 'http://127.0.0.1:6610';
  const app = buildApp(database.pool, migrations, { logger: false }, { origin, secure: false });
  const password = randomBytes(16).toString('hex');
  const replacement = randomBytes(16).toString('hex');
  const cli = path.resolve(__dirname, '../src/accounts-cli.js');
  const env = {
    ...process.env, DATABASE_URL: database.connectionString, NODE_ENV: 'development',
    ACCOUNT_USERNAME: 'adena', ACCOUNT_PASSWORD: password,
  };
  try {
    await migrate(database.pool, migrations);
    await assert.rejects(bootstrapAdmin(database.pool, 'adena', password, { NODE_ENV: 'production' }), /development is required/);
    await assert.rejects(readAccountPassword({}), /supply exactly one/);
    const created = await exec(process.execPath, [cli, 'bootstrap'], { env });
    assert.match(created.stdout, /"created":true/);
    assert(!created.stdout.includes(password));
    const repeated = await exec(process.execPath, [cli, 'bootstrap'], { env: { ...env, ACCOUNT_PASSWORD: replacement } });
    assert.match(repeated.stdout, /"created":false/);
    const login = (value: string) => app.inject({
      method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'adena', password: value },
    });
    const loggedIn = await login(password);
    assert.equal(loggedIn.statusCode, 200);
    assert.equal(loggedIn.json().account.role, 'admin');
    const cookie = loggedIn.cookies[0];
    assert(cookie);
    assert.equal((await login(replacement)).statusCode, 401, 'bootstrap must not reset an existing password');
    const rotated = await exec(process.execPath, [cli, 'password'], { env: { ...env, ACCOUNT_PASSWORD: replacement } });
    assert.match(rotated.stdout, /password_changed_sessions_revoked/);
    assert(!rotated.stdout.includes(replacement));
    assert.equal((await login(password)).statusCode, 401);
    assert.equal((await login(replacement)).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/auth/session', headers: { cookie: `${cookie.name}=${cookie.value}` } })).statusCode, 401);
    const count = await database.pool.query('SELECT count(*)::int AS count FROM users');
    assert.equal(count.rows[0]?.['count'], 1);
  } finally {
    await app.close();
    await database.close();
  }
});
