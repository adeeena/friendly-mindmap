import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Writable } from 'node:stream';
import { buildApp } from '../src/app';
import { Authentication, readAuthConfig } from '../src/auth';
import { hashPassword } from '../src/credentials';
import { migrate, readMigrations } from '../src/migrations';
import { isolatedPostgres } from './postgres';
import { loggerOptions } from '../src/errors';

test('production requires HTTPS while development HTTP is restricted to loopback', () => {
  assert.throws(() => readAuthConfig({ NODE_ENV: 'production' }), /APP_ORIGIN/);
  assert.throws(() => readAuthConfig({ NODE_ENV: 'production', APP_ORIGIN: 'http://localhost:6610' }), /HTTPS/);
  assert.throws(() => readAuthConfig({ APP_ORIGIN: 'http://example.com' }), /HTTPS/);
  assert.deepEqual(readAuthConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://mindmap.example' }), {
    origin: 'https://mindmap.example', secure: true,
  });
});

test('sessions rotate, enforce CSRF/origin, expire, revoke and never register', { timeout: 240_000 }, async () => {
  const database = await isolatedPostgres();
  const migrations = await readMigrations();
  const origin = 'http://127.0.0.1:6610';
  const logs: string[] = [];
  const stream = new Writable({ write: (chunk, _encoding, done) => { logs.push(String(chunk)); done(); } });
  const app = buildApp(database.pool, migrations, { logger: { ...loggerOptions, stream } }, { origin, secure: false });
  const guards = new Authentication(database.pool, { origin, secure: false });
  app.post('/test/private', async (request) => (await guards.requireSession(request, true)).account);
  const password = randomBytes(16).toString('hex');
  try {
    await migrate(database.pool, migrations);
    await database.pool.query(
      'INSERT INTO users(id,username,display_name,password_hash,role) VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(), 'adena', 'Adena', await hashPassword(password), 'admin'],
    );
    const login = (cookie?: string) => app.inject({
      method: 'POST', url: '/api/auth/login', headers: { origin, ...(cookie ? { cookie } : {}) },
      payload: { username: 'adena', password },
    });
    assert.equal((await app.inject('/api/auth/session')).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/register', payload: {} })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'adena', password } })).statusCode, 403);
    const first = await login();
    assert.equal(first.statusCode, 200);
    assert(!first.body.includes(password));
    const cookie1 = first.cookies[0];
    assert(cookie1);
    const cookieHeader = `${cookie1.name}=${cookie1.value}`;
    assert(cookie1.httpOnly);
    assert.equal(cookie1.sameSite, 'Strict');
    const stored = await database.pool.query('SELECT token_hash,csrf_hash FROM sessions');
    assert.notEqual(stored.rows[0]?.['token_hash'], cookie1.value);
    assert.notEqual(stored.rows[0]?.['csrf_hash'], first.json().csrfToken);
    const session = await app.inject({ url: '/api/auth/session', headers: { cookie: cookieHeader } });
    assert.equal(session.json().csrfToken, first.json().csrfToken);
    assert.equal((await app.inject({ url: '/api/boards', headers: {
      cookie: cookieHeader, 'x-session-id': first.json().sessionId,
    } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/boards', headers: {
      cookie: cookieHeader, 'x-session-id': randomUUID(),
    } })).statusCode, 401, 'a cookie change cannot hydrate another account into a captured workspace');
    assert.equal((await app.inject({ method: 'POST', url: '/test/private', headers: { origin, cookie: cookieHeader } })).statusCode, 403);
    const headers = { origin, cookie: cookieHeader, 'x-csrf-token': first.json().csrfToken as string };
    assert.equal((await app.inject({ method: 'POST', url: '/test/private', headers })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/test/private', headers: { ...headers, origin: 'https://attacker.example' } })).statusCode, 403);
    const second = await login(cookieHeader);
    const cookie2 = second.cookies[0];
    assert(cookie2 && cookie2.value !== cookie1.value);
    assert.equal((await app.inject({ url: '/api/auth/session', headers: { cookie: cookieHeader } })).statusCode, 401);
    const headers2 = { origin, cookie: `${cookie2.name}=${cookie2.value}`, 'x-csrf-token': second.json().csrfToken as string };
    assert.equal((await app.inject({ url: '/api/boards', headers: {
      ...headers2, 'x-session-id': first.json().sessionId,
    } })).statusCode, 401);
    assert.equal((await app.inject({
      method: 'POST', url: '/api/auth/logout', headers: headers2, payload: { sessionId: first.json().sessionId },
    })).statusCode, 204);
    assert.equal((await app.inject({ url: '/api/auth/session', headers: headers2 })).statusCode, 200);
    assert.equal((await app.inject({
      method: 'POST', url: '/api/auth/logout', headers: headers2,
      payload: { sessionId: second.json().sessionId, clearCookie: 'invalid' },
    })).statusCode, 400);
    assert.equal((await app.inject({ url: '/api/auth/session', headers: headers2 })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: headers2 })).statusCode, 204);
    assert.equal((await app.inject({ url: '/api/auth/session', headers: headers2 })).statusCode, 401);
    const third = await login();
    const cookie3 = third.cookies[0];
    assert(cookie3);
    await database.pool.query('UPDATE sessions SET idle_expires_at=now()-interval \'1 minute\' WHERE id=$1', [third.json().sessionId]);
    assert.equal((await app.inject({ url: '/api/auth/session', headers: { cookie: `${cookie3.name}=${cookie3.value}` } })).statusCode, 401);
    const fourth = await login();
    const cookie4 = fourth.cookies[0]!;
    const fourthHeaders = { origin, cookie: `${cookie4.name}=${cookie4.value}`, 'x-csrf-token': fourth.json().csrfToken as string };
    const deferred = await app.inject({
      method: 'POST', url: '/api/auth/logout', headers: fourthHeaders,
      payload: { sessionId: fourth.json().sessionId, clearCookie: false },
    });
    assert.equal(deferred.statusCode, 204);
    assert.equal(deferred.cookies.length, 0, 'a late deferred response must not clear a newer browser cookie');
    assert.equal((await app.inject({ url: '/api/auth/session', headers: fourthHeaders })).statusCode, 401);
    const secureApp = buildApp(database.pool, migrations, { logger: false }, {
      origin: 'https://mindmap.example', secure: true,
    });
    try {
      const secureLogin = await secureApp.inject({
        method: 'POST', url: '/api/auth/login', headers: { origin: 'https://mindmap.example' },
        payload: { username: 'adena', password },
      });
      assert.equal(secureLogin.statusCode, 200);
      assert.equal(secureLogin.cookies[0]?.name, '__Host-mindmap');
      assert.equal(secureLogin.cookies[0]?.secure, true);
    } finally {
      await secureApp.close();
    }
    assert(!logs.join('').includes(password));
    assert(!logs.join('').includes(cookie1.value));
    assert(!logs.join('').includes(first.json().csrfToken as string));
  } finally {
    await app.close();
    await database.close();
  }
});
