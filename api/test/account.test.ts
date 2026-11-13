import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app';
import { Authentication } from '../src/auth';
import { hashPassword } from '../src/credentials';
import { transaction } from '../src/database';
import { activeAccount, ownedBoard } from '../src/guards';
import { migrate, readMigrations } from '../src/migrations';
import { isolatedPostgres } from './postgres';

test('configuration revisions and shared ownership guards enforce current account roles', { timeout: 240_000 }, async () => {
  const database = await isolatedPostgres();
  const migrations = await readMigrations();
  const origin = 'http://127.0.0.1:6610';
  const app = buildApp(database.pool, migrations, { logger: false }, { origin, secure: false });
  const auth = new Authentication(database.pool, { origin, secure: false });
  app.get<{ Params: { id: string } }>('/test/board/:id', async (request) => {
    const session = await auth.requireSession(request);
    return transaction(database.pool, async (client) => {
      const account = await activeAccount(client, session.account.id);
      const board = await ownedBoard(client, account.id, request.params.id);
      return { id: board.id, role: account.role };
    });
  });
  try {
    await migrate(database.pool, migrations);
    const password = randomBytes(16).toString('hex');
    const encoded = await hashPassword(password);
    const owner = randomUUID();
    const other = randomUUID();
    const board = randomUUID();
    for (const [id, username, role] of [[owner, 'basic', 'basic'], [other, 'admin', 'admin']]) {
      await database.pool.query(
        'INSERT INTO users(id,username,display_name,password_hash,role) VALUES ($1,$2,$2,$3,$4)',
        [id, username, encoded, role],
      );
    }
    await database.pool.query(
      'INSERT INTO boards(id,owner_id,name,content,schema_version,content_hash) VALUES ($1,$2,$3,$4,2,$5)',
      [board, owner, 'Private', '{}', 'hash'],
    );
    const login = async (username: string) => {
      const result = await app.inject({
        method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username, password },
      });
      assert.equal(result.statusCode, 200);
      const cookie = result.cookies[0];
      assert(cookie);
      return { origin, cookie: `${cookie.name}=${cookie.value}`, 'x-csrf-token': result.json().csrfToken as string };
    };
    const basic = await login('basic');
    const admin = await login('admin');
    assert.equal((await app.inject({ url: `/test/board/${board}`, headers: basic })).json().role, 'basic');
    assert.equal((await app.inject({ url: `/test/board/${board}`, headers: admin })).statusCode, 404);
    const patch = (payload: unknown) => app.inject({
      method: 'PATCH', url: '/api/account/configuration',
      headers: { ...basic, 'content-type': 'application/json' }, payload: JSON.stringify(payload),
    });
    assert.equal((await patch({ expectedRevision: '0', changes: { theme: 'pale-rose' }, role: 'admin' })).statusCode, 400);
    assert.equal((await patch({ expectedRevision: '0', changes: { theme: 'unsupported' } })).statusCode, 400);
    const saved = await patch({ expectedRevision: '0', changes: { theme: 'pale-rose' } });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().revision, '1');
    assert.equal((await patch({ expectedRevision: '0', changes: { language: 'hu' } })).statusCode, 409);
    assert.deepEqual((await patch({ expectedRevision: '1', changes: { language: 'hu' } })).json(), {
      configuration: { theme: 'pale-rose', language: 'hu' }, revision: '2',
    });
    assert.deepEqual((await app.inject({ url: '/api/account/configuration', headers: admin })).json().configuration, {});
    await database.pool.query("UPDATE users SET role='admin' WHERE id=$1", [owner]);
    assert.equal((await app.inject({ url: `/test/board/${board}`, headers: basic })).json().role, 'admin');
  } finally {
    await app.close();
    await database.close();
  }
});
