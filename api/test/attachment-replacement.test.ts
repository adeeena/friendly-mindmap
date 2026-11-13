import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AttachmentMeta, ROOT_KEY, SCHEMA_VERSION, createBoard, createNode } from '../../shared/model';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/credentials';
import { migrate, readMigrations } from '../src/migrations';
import { isolatedPostgres } from './postgres';
import { isolatedStorage } from './storage';

test('a basic user can replace the only file on a block, but can never keep two', { timeout: 300_000 }, async () => {
  const database = await isolatedPostgres();
  let objectStore: Awaited<ReturnType<typeof isolatedStorage>> | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    objectStore = await isolatedStorage();
    const migrations = await readMigrations();
    await migrate(database.pool, migrations);
    const origin = 'http://127.0.0.1:6610';
    app = buildApp(database.pool, migrations, { logger: false }, { origin, secure: false }, objectStore.storage);
    const password = randomBytes(16).toString('hex');
    await database.pool.query('INSERT INTO users(id,username,display_name,password_hash,role) VALUES ($1,$2,$2,$3,$4)',
      [randomUUID(), 'basic', await hashPassword(password), 'basic']);
    const session = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'basic', password } });
    assert.equal(session.statusCode, 200);
    const cookie = session.cookies[0];
    assert(cookie);
    const headers = { origin, cookie: `${cookie.name}=${cookie.value}`, 'x-csrf-token': String(session.json().csrfToken) };

    const boardId = randomUUID();
    const path = `/api/boards/${boardId}`;
    assert.equal((await app.inject({ method: 'POST', url: `${path}/staging`, headers })).statusCode, 200);

    const call = (method: 'POST' | 'PUT', url: string, options: { headers?: Record<string, string>; payload?: unknown } = {}) => {
      assert(app);
      return app.inject({ method, url, headers: { ...headers, ...options.headers }, payload: options.payload as never });
    };
    const initiate = (uploadId: string, size: number) => call('POST', `${path}/uploads/${uploadId}`, {
      payload: { nodeId: 'node', name: 'photo.webp', mime: 'image/webp', size },
    });
    const upload = async (bytes: Buffer): Promise<AttachmentMeta> => {
      const uploadId = randomUUID();
      assert.equal((await initiate(uploadId, bytes.length)).statusCode, 200);
      assert.equal((await call('PUT', `${path}/uploads/${uploadId}/parts/1`, {
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) }, payload: bytes,
      })).statusCode, 200);
      const done = await call('POST', `${path}/uploads/${uploadId}/complete`);
      assert.equal(done.statusCode, 200, done.body);
      return done.json().attachment as AttachmentMeta;
    };
    const save = (expectedRevision: string | null, files: AttachmentMeta[]) => {
      const doc = createBoard('Photos', boardId);
      doc.nodes['node'] = createNode({ id: 'node', attachments: files });
      doc.children[ROOT_KEY] = ['node'];
      return call('PUT', path, {
        payload: { mutationId: randomUUID(), expectedRevision, schemaVersion: SCHEMA_VERSION, doc, camera: { x: 0, y: 0, zoom: 1 } },
      });
    };

    const original = await upload(Buffer.alloc(2048, 1));
    const published = await save(null, [original]);
    assert.equal(published.statusCode, 200, published.body);

    // The original is still the committed file for the block; a replacement may nevertheless be uploaded.
    const smaller = await upload(Buffer.alloc(512, 2));

    // Only one replacement may be in flight, so storage stays bounded.
    assert.equal((await initiate(randomUUID(), 1)).statusCode, 422, 'a second pending file on the block is refused');

    // Saving never keeps two files on a block for a basic user...
    assert.equal((await save('1', [original, smaller])).statusCode, 422);
    // ...but swapping one for the other is accepted.
    const swapped = await save('1', [smaller]);
    assert.equal(swapped.statusCode, 200, swapped.body);
    assert.deepEqual((await app.inject({ url: `${path}/attachments/${smaller.id}`, headers })).rawPayload, Buffer.alloc(512, 2));

    // After the swap the block can be replaced again.
    assert.equal((await initiate(randomUUID(), 1)).statusCode, 200);
  } finally {
    await app?.close();
    try { await objectStore?.close(); } finally { await database.close(); }
  }
});
