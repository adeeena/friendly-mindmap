import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { buildApp } from '../src/app';
import { digest, hashPassword } from '../src/credentials';
import { migrate, readMigrations } from '../src/migrations';
import { isolatedPostgres } from './postgres';
import { isolatedStorage } from './storage';

test('private real S3 attachments enforce owner refs and safe download headers', { timeout: 300_000 }, async () => {
  const database = await isolatedPostgres();
  let objectStore: Awaited<ReturnType<typeof isolatedStorage>> | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    objectStore = await isolatedStorage();
    const storage = objectStore.storage;
    const migrations = await readMigrations();
    await migrate(database.pool, migrations);
    const origin = 'http://127.0.0.1:6610';
    app = buildApp(database.pool, migrations, { logger: false }, { origin, secure: false }, storage);
    const instance = app;
    const password = randomBytes(16).toString('hex');
    const encoded = await hashPassword(password);
    const owner = randomUUID();
    const board = randomUUID();
    const attachment = randomUUID();
    for (const [id, username] of [[owner, 'owner'], [randomUUID(), 'other']]) {
      await database.pool.query('INSERT INTO users(id,username,display_name,password_hash) VALUES ($1,$2,$2,$3)', [id, username, encoded]);
    }
    await database.pool.query('INSERT INTO boards(id,owner_id,name,content,schema_version,content_hash) VALUES ($1,$2,$3,$4,2,$5)',
      [board, owner, 'Files', '{}', 'hash']);
    const content = '<svg onload="alert(1)"/>';
    await storage.client.send(new PutObjectCommand({
      Bucket: storage.config.bucket, Key: attachment, Body: content, ContentType: 'image/svg+xml',
    }));
    await database.pool.query(`INSERT INTO board_attachments
      (id,board_id,owner_id,uploader_id,storage_key,name,mime,size_bytes,checksum,state)
      VALUES ($1::uuid,$2,$3,$3,$1::text,$4,'image/svg+xml',$5,$6,'ready')`,
    [attachment, board, owner, 'image.svg', Buffer.byteLength(content), digest(content)]);
    await database.pool.query('INSERT INTO board_attachment_refs(board_id,node_id,attachment_id) VALUES ($1,$2,$3)', [board, 'node', attachment]);
    const login = async (username: string) => {
      const result = await instance.inject({
        method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username, password },
      });
      assert.equal(result.statusCode, 200);
      const cookie = result.cookies[0];
      assert(cookie);
      return { cookie: `${cookie.name}=${cookie.value}` };
    };
    const headers = await login('owner');
    const other = await login('other');
    const url = `/api/boards/${board}/attachments/${attachment}`;
    assert.equal((await instance.inject({ url, headers: other })).statusCode, 404);
    const downloaded = await instance.inject({ url, headers });
    assert.equal(downloaded.statusCode, 200);
    assert.equal(downloaded.body, content);
    assert.equal(downloaded.headers['content-type'], 'application/octet-stream');
    assert.match(String(downloaded.headers['content-disposition']), /^attachment;/);
    assert.equal(downloaded.headers['x-content-type-options'], 'nosniff');
    assert.equal(downloaded.headers['cache-control'], 'no-store');
    assert.equal(downloaded.headers['x-content-sha256'], digest(content));
    assert.equal((await instance.inject('/api/health/ready')).statusCode, 200);
    await database.pool.query('DELETE FROM board_attachment_refs WHERE attachment_id=$1', [attachment]);
    assert.equal((await instance.inject({ url, headers })).statusCode, 404, 'unreferenced staged files are not downloadable');
  } finally {
    await app?.close();
    try { await objectStore?.close(); } finally { await database.close(); }
  }
});
