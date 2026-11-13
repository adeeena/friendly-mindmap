import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createBoard, SCHEMA_VERSION } from '../../shared/model';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/credentials';
import { migrate, readMigrations } from '../src/migrations';
import { isolatedPostgres } from './postgres';

test('board API enforces ownership/revisions, retry receipts, tombstones and content history', { timeout: 240_000 }, async () => {
  const database = await isolatedPostgres();
  const migrations = await readMigrations();
  const origin = 'http://127.0.0.1:6610';
  const app = buildApp(database.pool, migrations, { logger: false }, { origin, secure: false });
  try {
    await migrate(database.pool, migrations);
    const password = randomBytes(16).toString('hex');
    const encoded = await hashPassword(password);
    const user = randomUUID();
    for (const [id, name] of [[user, 'basic'], [randomUUID(), 'other']]) {
      await database.pool.query('INSERT INTO users(id,username,display_name,password_hash) VALUES ($1,$2,$2,$3)', [id, name, encoded]);
    }
    const login = async (username: string) => {
      const response = await app.inject({
        method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username, password },
      });
      assert.equal(response.statusCode, 200);
      const cookie = response.cookies[0];
      assert(cookie);
      return { origin, cookie: `${cookie.name}=${cookie.value}`, 'x-csrf-token': response.json().csrfToken as string };
    };
    const headers = await login('basic');
    const other = await login('other');
    const id = randomUUID();
    const doc = createBoard('Cloud', id);
    const input = {
      mutationId: randomUUID(), expectedRevision: null as string | null,
      schemaVersion: SCHEMA_VERSION, doc, camera: { x: 0, y: 0, zoom: 1 },
    };
    const save = (payload: typeof input, who = headers) => app.inject({ method: 'PUT', url: `/api/boards/${id}`, headers: who, payload });
    const [created, repeated] = await Promise.all([save(input), save(input)]);
    assert.equal(created.statusCode, 200);
    assert.deepEqual(repeated.json(), created.json());
    assert.equal(created.json().revision, '1');
    assert.equal((await save({ ...input, mutationId: randomUUID() })).statusCode, 409);
    assert.equal((await save({ ...input, doc: { ...doc, name: 'Different' } })).statusCode, 409);
    assert.equal((await app.inject({ url: `/api/boards/${id}`, headers: other })).statusCode, 404);
    assert.deepEqual((await app.inject({ url: '/api/boards', headers: other })).json(), []);
    assert.equal((await save({ ...input, mutationId: randomUUID(), expectedRevision: '1' }, other)).statusCode, 404);
    const noOp = await save({ ...input, mutationId: randomUUID(), expectedRevision: '1' });
    assert.equal(noOp.json().revision, '1');
    const moved = await save({ ...input, mutationId: randomUUID(), expectedRevision: '1', camera: { x: 20, y: 0, zoom: 1 } });
    assert.equal(moved.json().revision, '2');
    assert.equal(moved.json().contentRevision, '1');
    const renameInput = { ...input, mutationId: randomUUID(), expectedRevision: '2', doc: { ...doc, name: 'Renamed' } };
    const renamed = await save(renameInput);
    assert.equal(renamed.json().revision, '3');
    assert.equal(renamed.json().contentRevision, '2');
    assert.deepEqual((await save(renameInput)).json(), renamed.json());
    assert.equal((await save({ ...input, mutationId: randomUUID(), expectedRevision: '1' })).statusCode, 409);
    assert.equal((await save({ ...input, mutationId: randomUUID(), expectedRevision: '3', schemaVersion: SCHEMA_VERSION + 1 })).statusCode, 422);
    assert.equal((await save({ ...input, mutationId: randomUUID(), expectedRevision: '3', doc: { ...doc, id: randomUUID() } })).statusCode, 400);
    const missing = await app.inject({
      method: 'PUT', url: `/api/boards/${randomUUID()}`, headers,
      payload: { ...input, mutationId: randomUUID(), expectedRevision: '1' },
    });
    assert.equal(missing.statusCode, 400, 'path/document identity mismatch is rejected');
    const absentId = randomUUID();
    assert.equal((await app.inject({
      method: 'PUT', url: `/api/boards/${absentId}`, headers,
      payload: { ...input, mutationId: randomUUID(), expectedRevision: '1', doc: { ...doc, id: absentId } },
    })).statusCode, 404);
    await database.pool.query('UPDATE boards SET schema_version=$2 WHERE id=$1', [id, SCHEMA_VERSION + 1]);
    assert.equal((await save({ ...input, mutationId: randomUUID(), expectedRevision: '3' })).statusCode, 422);
    await database.pool.query('UPDATE boards SET schema_version=$2 WHERE id=$1', [id, SCHEMA_VERSION]);
    const stored = await app.inject({ url: `/api/boards/${id}`, headers });
    assert.equal(stored.json().name, 'Renamed');
    assert.equal(stored.json().schemaVersion, SCHEMA_VERSION);
    const histories = await database.pool.query('SELECT content_revision FROM board_history WHERE board_id=$1 ORDER BY content_revision', [id]);
    assert.deepEqual(histories.rows.map((row) => row['content_revision']), ['1', '2']);
    const remove = (payload: { mutationId: string; expectedRevision: string }) =>
      app.inject({ method: 'DELETE', url: `/api/boards/${id}`, headers, payload });
    assert.equal((await remove({ mutationId: randomUUID(), expectedRevision: '2' })).statusCode, 409);
    const deletion = { mutationId: randomUUID(), expectedRevision: '3' };
    const deleted = await remove(deletion);
    assert.equal(deleted.statusCode, 200);
    assert.deepEqual((await remove(deletion)).json(), deleted.json());
    assert.equal((await app.inject({ url: `/api/boards/${id}`, headers })).statusCode, 404);
    assert.equal((await save({ ...input, mutationId: randomUUID() })).statusCode, 409, 'tombstone prevents create-only resurrection');
    assert.equal((await save({ ...input, mutationId: randomUUID(), expectedRevision: '3' })).statusCode, 410);
    const tombstones = await app.inject({ url: '/api/boards?includeDeleted=true', headers });
    assert.equal(tombstones.json()[0].id, id);
    assert(tombstones.json()[0].deletedAt);
    assert.equal((await database.pool.query('SELECT content FROM boards WHERE id=$1', [id])).rows[0]?.['content'], null);
    assert.equal((await database.pool.query('SELECT * FROM board_history WHERE board_id=$1', [id])).rowCount, 0);
  } finally {
    await app.close();
    await database.close();
  }
});
