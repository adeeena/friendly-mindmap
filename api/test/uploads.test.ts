import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { BASIC_ATTACHMENT_BYTES, attachmentPolicyViolation } from '../../shared/attachment-policy';
import { AttachmentMeta, ROOT_KEY, SCHEMA_VERSION, createBoard, createNode } from '../../shared/model';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/credentials';
import { migrate, readMigrations } from '../src/migrations';
import { uploadPartSize } from '../src/uploads';
import { cleanupAttachments } from '../src/attachment-cleanup';
import { isolatedPostgres } from './postgres';
import { isolatedStorage } from './storage';

test('attachment policy uses exact basic/guest boundaries and provider-aware admin parts', () => {
  for (const role of ['guest', 'basic'] as const) {
    assert.equal(attachmentPolicyViolation(role, [BASIC_ATTACHMENT_BYTES]), null);
    assert.equal(attachmentPolicyViolation(role, [BASIC_ATTACHMENT_BYTES + 1]), 'size');
    assert.equal(attachmentPolicyViolation(role, [1, 1]), 'count');
  }
  assert.equal(attachmentPolicyViolation('admin', [BASIC_ATTACHMENT_BYTES + 1, BASIC_ATTACHMENT_BYTES * 10]), null);
  assert(uploadPartSize(1024 ** 4) * 10_000 >= 1024 ** 4);
});

test('real multipart uploads resume, finalize once, enforce roles/slots and cancel safely', { timeout: 300_000 }, async () => {
  const database = await isolatedPostgres();
  let objectStore: Awaited<ReturnType<typeof isolatedStorage>> | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    objectStore = await isolatedStorage();
    const storage = objectStore.storage;
    const migrations = await readMigrations();
    await migrate(database.pool, migrations);
    const origin = 'http://127.0.0.1:6610';
    const makeApp = () => buildApp(database.pool, migrations, { logger: false }, { origin, secure: false }, storage);
    app = makeApp();
    const password = randomBytes(16).toString('hex');
    const encoded = await hashPassword(password);
    const owner = randomUUID();
    const board = randomUUID();
    for (const [id, username, role] of [[owner, 'owner', 'admin'], [randomUUID(), 'other', 'basic']]) {
      await database.pool.query('INSERT INTO users(id,username,display_name,password_hash,role) VALUES ($1,$2,$2,$3,$4)',
        [id, username, encoded, role]);
    }
    await database.pool.query('INSERT INTO boards(id,owner_id,name,content,schema_version,content_hash) VALUES ($1,$2,$3,$4,2,$5)',
      [board, owner, 'Files', '{}', 'hash']);
    const login = async (username: string) => {
      assert(app);
      const response = await app.inject({
        method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username, password },
      });
      assert.equal(response.statusCode, 200);
      const cookie = response.cookies[0];
      assert(cookie);
      return { origin, cookie: `${cookie.name}=${cookie.value}`, 'x-csrf-token': String(response.json().csrfToken) };
    };
    const headers = await login('owner');
    const other = await login('other');
    const root = `/api/boards/${board}/uploads`;
    const initiate = (id: string, size: number, nodeId = 'node') => {
      assert(app);
      return app.inject({
        method: 'POST', url: `${root}/${id}`, headers,
        payload: { nodeId, name: 'file.bin', mime: 'application/octet-stream', size },
      });
    };
    const uploadId = randomUUID();
    const size = 8 * 1024 * 1024 + 17;
    const started = await initiate(uploadId, size);
    assert.equal(started.statusCode, 200, started.body);
    const info = started.json();
    assert.equal(info.state, 'uploading');
    assert.equal((await initiate(uploadId, size)).json().attachmentId, info.attachmentId);
    assert.equal((await initiate(uploadId, size + 1)).statusCode, 409);
    assert.equal((await app.inject({ url: `${root}/${uploadId}`, headers: other })).statusCode, 404);
    assert.equal((await app.inject({
      method: 'POST', url: `${root}/${uploadId}/complete`, headers: { origin, cookie: headers.cookie },
    })).statusCode, 403);
    const first = Buffer.alloc(info.partSize, 42);
    const last = Buffer.alloc(17, 7);
    const part = (number: number, payload: Buffer) => {
      assert(app);
      return app.inject({
        method: 'PUT', url: `${root}/${uploadId}/parts/${number}`,
        headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': String(payload.length) }, payload,
      });
    };
    assert.equal((await part(1, first)).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `${root}/${uploadId}/complete`, headers })).statusCode, 422);
    assert.equal((await app.inject({ url: `/api/boards/${board}/attachments/${info.attachmentId}`, headers })).statusCode, 404);
    await app.close();
    app = makeApp();
    const resumed = await app.inject({ url: `${root}/${uploadId}`, headers });
    assert.equal(resumed.json().parts.length, 1);
    assert.equal(resumed.json().parts[0].number, 1);
    assert.equal(resumed.json().parts[0].size, first.length);
    assert.equal((await part(2, last)).statusCode, 200);
    const completed = await app.inject({ method: 'POST', url: `${root}/${uploadId}/complete`, headers });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(completed.json().attachment.size, size);
    assert.equal(completed.json().attachment.checksum, createHash('sha256').update(first).update(last).digest('hex'));
    assert.deepEqual((await app.inject({ method: 'POST', url: `${root}/${uploadId}/complete`, headers })).json(), completed.json());
    assert.equal((await part(2, last)).statusCode, 409);
    assert.equal((await initiate(randomUUID(), size)).statusCode, 200, 'admin may have multiple pending files on one node');
    await database.pool.query("UPDATE users SET role='basic' WHERE id=$1", [owner]);
    assert.equal((await initiate(randomUUID(), BASIC_ATTACHMENT_BYTES + 1)).statusCode, 422, 'role comes from the database');
    const exact = randomUUID();
    assert.equal((await initiate(exact, BASIC_ATTACHMENT_BYTES, 'exact')).statusCode, 200);
    assert.equal((await app.inject({
      method: 'PUT', url: `${root}/${exact}/parts/1`,
      headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': String(BASIC_ATTACHMENT_BYTES) },
      payload: Buffer.alloc(BASIC_ATTACHMENT_BYTES),
    })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `${root}/${exact}/complete`, headers })).statusCode, 200);
    const invalid = randomUUID();
    assert.equal((await initiate(invalid, 1, 'invalid')).statusCode, 200);
    const excess = await app.inject({
      method: 'PUT', url: `${root}/${invalid}/parts/1`,
      headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': '1' },
      payload: Buffer.alloc(2),
    });
    assert.equal(excess.statusCode, 422, excess.body);
    assert.equal((await app.inject({ method: 'POST', url: `${root}/${invalid}/complete`, headers })).statusCode, 422);
    const empty = randomUUID();
    assert.equal((await initiate(empty, 0, 'empty')).statusCode, 200);
    assert.equal((await app.inject({
      method: 'PUT', url: `${root}/${empty}/parts/1`,
      headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': '0' }, payload: Buffer.alloc(0),
    })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `${root}/${empty}/complete`, headers })).statusCode, 200);
    const basicId = randomUUID();
    const competitor = randomUUID();
    const concurrent = await Promise.all([initiate(basicId, BASIC_ATTACHMENT_BYTES, 'basic'), initiate(competitor, 1, 'basic')]);
    assert.deepEqual(concurrent.map((r) => r.statusCode).sort(), [200, 422]);
    const acceptedId = concurrent[0]?.statusCode === 200 ? basicId : competitor;
    const acceptedSize = acceptedId === basicId ? BASIC_ATTACHMENT_BYTES : 1;
    const boundary = await app.inject({
      method: 'PUT', url: `${root}/${acceptedId}/parts/1`,
      headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': String(acceptedSize) },
      payload: Buffer.alloc(acceptedSize),
    });
    assert.equal(boundary.statusCode, 200, boundary.body);
    const boundaryDone = await app.inject({ method: 'POST', url: `${root}/${acceptedId}/complete`, headers });
    assert.equal(boundaryDone.statusCode, 200, boundaryDone.body);
    assert.equal((await initiate(randomUUID(), 1, 'basic')).statusCode, 422, 'finalized unpublished file keeps its node reservation');
    const cancelled = await app.inject({ method: 'DELETE', url: `${root}/${acceptedId}`, headers });
    assert.equal(cancelled.statusCode, 200);
    assert.equal((await app.inject({ method: 'DELETE', url: `${root}/${acceptedId}`, headers })).statusCode, 200);
    assert.equal((await app.inject({ url: `${root}/${acceptedId}`, headers })).statusCode, 410);
    const next = randomUUID();
    assert.equal((await initiate(next, 1, 'basic')).statusCode, 200, 'cancel releases reservation');
    await database.pool.query("UPDATE attachment_uploads SET expires_at=now()-interval '1 second' WHERE id=$1", [next]);
    assert.equal((await app.inject({ url: `${root}/${next}`, headers })).statusCode, 410);
    assert.equal((await initiate(randomUUID(), 1, 'basic')).statusCode, 200, 'expiry releases reservation');

    const staged = randomUUID();
    const stagedPath = `/api/boards/${staged}`;
    assert.equal((await app.inject({ method: 'POST', url: `${stagedPath}/staging`, headers })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `${stagedPath}/staging`, headers })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `${stagedPath}/staging`, headers: other })).statusCode, 409);
    assert.equal((await app.inject({ url: stagedPath, headers })).statusCode, 404);
    assert(!(await app.inject({ url: '/api/boards?includeDeleted=true', headers })).json().some((row: { id: string }) => row.id === staged));
    const stagedUpload = `${stagedPath}/uploads/${randomUUID()}`;
    const stagedStart = await app.inject({
      method: 'POST', url: stagedUpload, headers,
      payload: { nodeId: 'node', name: 'copy.bin', mime: 'application/octet-stream', size: 1 },
    });
    assert.equal(stagedStart.statusCode, 200, stagedStart.body);
    assert.equal((await app.inject({
      method: 'PUT', url: `${stagedUpload}/parts/1`,
      headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': '1' }, payload: Buffer.from([1]),
    })).statusCode, 200);
    const file = (await app.inject({ method: 'POST', url: `${stagedUpload}/complete`, headers })).json().attachment as AttachmentMeta;
    const doc = createBoard('Imported', staged);
    doc.nodes['node'] = createNode({ id: 'node', attachments: [file] });
    doc.children[ROOT_KEY] = ['node'];
    const saveStaged = () => {
      assert(app);
      return app.inject({
        method: 'PUT', url: stagedPath, headers,
        payload: { mutationId: randomUUID(), expectedRevision: null, schemaVersion: SCHEMA_VERSION, doc, camera: { x: 0, y: 0, zoom: 1 } },
      });
    };
    doc.nodes['node'].attachments = [file, { ...file, id: randomUUID() }];
    assert.equal((await saveStaged()).statusCode, 422, 'invalid import count leaves the board hidden');
    doc.nodes['node'].attachments = [{ ...file, id: info.attachmentId }];
    assert.equal((await saveStaged()).statusCode, 422, 'another board attachment cannot be injected');
    doc.nodes['node'].attachments = [file];
    const key = `${staged}/${file.id}`;
    await storage.delete(key);
    assert.equal((await saveStaged()).statusCode, 422, 'ready metadata without bytes cannot publish');
    assert.equal((await app.inject({ url: stagedPath, headers })).statusCode, 404);
    assert.equal((await database.pool.query('SELECT 1 FROM board_history WHERE board_id=$1', [staged])).rowCount, 0);
    await storage.client.send(new PutObjectCommand({ Bucket: storage.config.bucket, Key: key, Body: Buffer.from([1]) }));
    const published = await saveStaged();
    assert.equal(published.statusCode, 200, published.body);
    assert.equal(published.json().revision, '1');
    assert.equal((await app.inject({ url: stagedPath, headers })).statusCode, 200);
    const fileUrl = `${stagedPath}/attachments/${file.id}`;
    const sourceBytes = (await app.inject({ url: fileUrl, headers })).rawPayload;
    assert.deepEqual(sourceBytes, Buffer.from([1]));
    assert.equal((await app.inject({ method: 'DELETE', url: stagedUpload, headers })).statusCode, 409, 'published/history references protect bytes');

    await database.pool.query("UPDATE users SET role='admin' WHERE id=$1", [owner]);
    const duplicate = randomUUID();
    const duplicatePath = `/api/boards/${duplicate}`;
    assert.equal((await app.inject({ method: 'POST', url: `${duplicatePath}/staging`, headers })).statusCode, 200);
    const duplicateFiles: AttachmentMeta[] = [];
    for (let index = 0; index < 2; index++) {
      const upload = `${duplicatePath}/uploads/${randomUUID()}`;
      assert.equal((await app.inject({
        method: 'POST', url: upload, headers,
        payload: { nodeId: 'node', name: file.name, mime: file.mime, size: sourceBytes.length },
      })).statusCode, 200);
      assert.equal((await app.inject({
        method: 'PUT', url: `${upload}/parts/1`,
        headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': String(sourceBytes.length) }, payload: sourceBytes,
      })).statusCode, 200);
      duplicateFiles.push((await app.inject({ method: 'POST', url: `${upload}/complete`, headers })).json().attachment as AttachmentMeta);
    }
    const duplicateDoc = structuredClone(doc);
    duplicateDoc.id = duplicate;
    duplicateDoc.nodes['node']!.attachments = duplicateFiles;
    const duplicateInput = {
      mutationId: randomUUID(), expectedRevision: null, schemaVersion: SCHEMA_VERSION,
      doc: duplicateDoc, camera: { x: 0, y: 0, zoom: 1 },
    };
    await database.pool.query("UPDATE users SET role='basic' WHERE id=$1", [owner]);
    assert.equal((await app.inject({ method: 'PUT', url: duplicatePath, headers, payload: duplicateInput })).statusCode, 422);
    assert.equal((await app.inject({ url: duplicatePath, headers })).statusCode, 404, 'downgrade cannot publish an over-policy duplicate');
    await database.pool.query("UPDATE users SET role='admin' WHERE id=$1", [owner]);
    assert.equal((await app.inject({ method: 'PUT', url: duplicatePath, headers, payload: duplicateInput })).statusCode, 200);
    assert.deepEqual((await app.inject({ url: `${duplicatePath}/attachments/${duplicateFiles[0]!.id}`, headers })).rawPayload, sourceBytes);
    assert.deepEqual((await app.inject({ url: fileUrl, headers })).rawPayload, sourceBytes, 'duplication preserves source bytes');

    await database.pool.query("UPDATE board_attachments SET updated_at=now()-interval '30 hours' WHERE id=$1", [file.id]);
    const active = randomUUID();
    assert.equal((await initiate(active, 1, 'active')).statusCode, 200);
    await database.pool.query(`UPDATE board_attachments SET updated_at=now()-interval '30 hours'
      WHERE id=(SELECT attachment_id FROM attachment_uploads WHERE id=$1)`, [active]);
    const expired = randomUUID();
    assert.equal((await initiate(expired, 1, 'expired')).statusCode, 200);
    await database.pool.query("UPDATE attachment_uploads SET expires_at=now()-interval '1 second' WHERE id=$1", [expired]);
    const abandoned = randomUUID();
    assert.equal((await app.inject({ method: 'POST', url: `/api/boards/${abandoned}/staging`, headers })).statusCode, 200);
    await database.pool.query("UPDATE boards SET updated_at=now()-interval '30 hours' WHERE id=$1", [abandoned]);
    const cleaned = await cleanupAttachments(database.pool, storage);
    assert(cleaned.objectsDeleted > 0);
    assert.equal(cleaned.expiredBoards, 1);
    assert.equal((await database.pool.query('SELECT 1 FROM attachment_uploads WHERE id=$1', [expired])).rowCount, 0);
    assert.equal((await app.inject({ url: `${root}/${active}`, headers })).statusCode, 200, 'active transfer survives cleanup');
    assert.equal(await storage.head(key), 1, 'current referenced bytes survive cleanup');
    await database.pool.query('DELETE FROM board_attachment_refs WHERE attachment_id=$1', [file.id]);
    await cleanupAttachments(database.pool, storage);
    assert.equal(await storage.head(key), 1, 'historical-only bytes survive cleanup');
    await database.pool.query('DELETE FROM board_history WHERE board_id=$1', [staged]);
    await cleanupAttachments(database.pool, storage);
    assert.equal((await database.pool.query('SELECT 1 FROM board_attachments WHERE id=$1', [file.id])).rowCount, 0, 'last reference removal allows cleanup');

    const retry = randomUUID();
    assert.equal((await initiate(retry, 1, 'retry')).statusCode, 200);
    await database.pool.query("UPDATE attachment_uploads SET expires_at=now()-interval '1 second' WHERE id=$1", [retry]);
    const removeObject = storage.delete.bind(storage);
    storage.delete = async () => { throw new Error('Injected storage deletion failure'); };
    try { await assert.rejects(cleanupAttachments(database.pool, storage), /Injected storage deletion failure/); }
    finally { storage.delete = removeObject; }
    assert.equal((await database.pool.query(`SELECT a.state FROM board_attachments a JOIN attachment_uploads u
      ON u.attachment_id=a.id WHERE u.id=$1`, [retry])).rows[0]?.['state'], 'deleting');
    await cleanupAttachments(database.pool, storage);
    assert.equal((await database.pool.query('SELECT 1 FROM attachment_uploads WHERE id=$1', [retry])).rowCount, 0, 'cleanup retries after a storage failure');
  } finally {
    await app?.close();
    try { await objectStore?.close(); } finally { await database.close(); }
  }
});
