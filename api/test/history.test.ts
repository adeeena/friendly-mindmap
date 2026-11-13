import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { AttachmentMeta, BoardDoc, ROOT_KEY, SCHEMA_VERSION, createBoard, createNode } from '../../shared/model';
import { buildApp } from '../src/app';
import { cleanupAttachments } from '../src/attachment-cleanup';
import { digest, hashPassword } from '../src/credentials';
import { migrate, readMigrations } from '../src/migrations';
import { isolatedPostgres } from './postgres';
import { isolatedStorage } from './storage';

test('board history is owner-only, restorable, role-retained and keeps attachment lifetime reference-aware', { timeout: 300_000 }, async () => {
  const database = await isolatedPostgres();
  let objectStore: Awaited<ReturnType<typeof isolatedStorage>> | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    objectStore = await isolatedStorage();
    const storage = objectStore.storage;
    const migrations = await readMigrations();
    await migrate(database.pool, migrations);
    const origin = 'http://127.0.0.1:6610';
    const instance = buildApp(database.pool, migrations, { logger: false }, { origin, secure: false }, storage);
    app = instance;
    const password = randomBytes(16).toString('hex');
    const encoded = await hashPassword(password);
    const basicOwner = randomUUID();
    const adminOwner = randomUUID();
    for (const [id, username, role] of [[basicOwner, 'basic', 'basic'], [adminOwner, 'admin', 'admin'], [randomUUID(), 'other', 'admin']]) {
      await database.pool.query('INSERT INTO users(id,username,display_name,password_hash,role) VALUES ($1,$2,$2,$3,$4)',
        [id, username, encoded, role]);
    }
    const login = async (username: string) => {
      const response = await instance.inject({
        method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username, password },
      });
      assert.equal(response.statusCode, 200);
      const cookie = response.cookies[0];
      assert(cookie);
      return { origin, cookie: `${cookie.name}=${cookie.value}`, 'x-csrf-token': String(response.json().csrfToken) };
    };
    const basic = await login('basic');
    const admin = await login('admin');
    const other = await login('other');

    const attachment = async (board: string, owner: string, name: string): Promise<AttachmentMeta> => {
      const id = randomUUID();
      const body = Buffer.from(name);
      await storage.client.send(new PutObjectCommand({ Bucket: storage.config.bucket, Key: `${board}/${id}`, Body: body }));
      await database.pool.query(`INSERT INTO board_attachments
        (id,board_id,owner_id,uploader_id,storage_key,name,mime,size_bytes,checksum,state)
        VALUES ($1,$2,$3,$3,$4,$5,'text/plain',$6,$7,'ready')`,
      [id, board, owner, `${board}/${id}`, name, body.length, digest(name)]);
      return { id, name, mime: 'text/plain', size: body.length };
    };
    const document = (id: string, name: string, files: Record<string, AttachmentMeta> = {}): BoardDoc => {
      const doc = createBoard(name, id);
      for (const [nodeId, file] of Object.entries(files)) {
        doc.nodes[nodeId] = createNode({ id: nodeId, attachments: [file] });
        doc.children[ROOT_KEY] = [...(doc.children[ROOT_KEY] ?? []), nodeId];
      }
      return doc;
    };
    const commit = (who: typeof basic, doc: BoardDoc, expectedRevision: string | null, mutationId = randomUUID(), camera = { x: 0, y: 0, zoom: 1 }) =>
      instance.inject({
        method: 'PUT', url: `/api/boards/${doc.id}`, headers: who,
        payload: { mutationId, expectedRevision, schemaVersion: SCHEMA_VERSION, doc, camera },
      });
    const retained = async (board: string) => (await database.pool.query<{ content_revision: string }>(
      'SELECT content_revision FROM board_history WHERE board_id=$1 ORDER BY content_revision', [board])).rows.map((row) => Number(row.content_revision));
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
    const current = async (who: typeof basic, board: string) => {
      const response = await instance.inject({ url: `/api/boards/${board}`, headers: who });
      assert.equal(response.statusCode, 200);
      return response.json() as { revision: string; contentRevision: string; name: string; doc: BoardDoc };
    };
    const restore = (who: typeof basic, board: string, contentRevision: number | string, expectedRevision: string, mutationId = randomUUID()) =>
      instance.inject({
        method: 'POST', url: `/api/boards/${board}/history/${contentRevision}/restore`, headers: who,
        payload: { mutationId, expectedRevision },
      });

    // Basic owner: commits 10/11/12 and the lifetime of a file referenced only by pruned history.
    const board = randomUUID();
    assert.equal((await instance.inject({ method: 'POST', url: `/api/boards/${board}/staging`, headers: basic })).statusCode, 200);
    const stale = await attachment(board, basicOwner, 'only-historical');
    const kept = await attachment(board, basicOwner, 'still-current');
    let saved = await commit(basic, document(board, 'v1', { first: stale, second: kept }), null);
    assert.equal(saved.statusCode, 200, saved.body);
    let revision = saved.json().revision as string;
    for (let version = 2; version <= 12; version++) {
      saved = await commit(basic, document(board, `v${version}`, { second: kept }), revision);
      assert.equal(saved.statusCode, 200, saved.body);
      revision = saved.json().revision;
      assert.equal(saved.json().contentRevision, String(version));
      assert.deepEqual(await retained(board), range(Math.max(1, version - 9), version));
      if (version === 10) {
        const download = await instance.inject({ url: `/api/boards/${board}/attachments/${stale.id}`, headers: basic });
        assert.equal(download.statusCode, 200, 'a file referenced only by retained history is retrievable');
        const detail = await instance.inject({ url: `/api/boards/${board}/history/1`, headers: basic });
        assert.deepEqual(detail.json().attachments.map((file: { id: string; available: boolean }) => [file.id, file.available]).sort(),
          [[stale.id, true], [kept.id, true]].sort());
      }
      if (version === 11) {
        const refs = await database.pool.query('SELECT 1 FROM board_history_attachments WHERE attachment_id=$1', [stale.id]);
        assert.equal(refs.rowCount, 0, 'pruning removes the final historical reference');
        assert.equal((await instance.inject({ url: `/api/boards/${board}/history/1`, headers: basic })).statusCode, 404);
        assert.equal((await instance.inject({ url: `/api/boards/${board}/attachments/${stale.id}`, headers: basic })).statusCode, 404);
        await database.pool.query("UPDATE board_attachments SET updated_at=now()-interval '30 hours' WHERE id=ANY($1::uuid[])", [[stale.id, kept.id]]);
        await cleanupAttachments(database.pool, storage);
        assert.equal((await database.pool.query('SELECT 1 FROM board_attachments WHERE id=$1', [stale.id])).rowCount, 0);
        await assert.rejects(storage.head(`${board}/${stale.id}`));
        assert.equal(await storage.head(`${board}/${kept.id}`), kept.size, 'current/history-referenced bytes survive');
      }
    }
    const afterTwelve = revision;

    // Camera-only and replayed saves never consume retention slots.
    const camera = await commit(basic, document(board, 'v12', { second: kept }), afterTwelve, randomUUID(), { x: 5, y: 5, zoom: 1 });
    assert.equal(camera.json().contentRevision, '12');
    assert.deepEqual(await retained(board), range(3, 12));
    const mutationId = randomUUID();
    const replayed = await commit(basic, document(board, 'v13', { second: kept }), camera.json().revision, mutationId);
    assert.equal(replayed.json().contentRevision, '13');
    assert.deepEqual((await commit(basic, document(board, 'v13', { second: kept }), camera.json().revision, mutationId)).json(), replayed.json());
    assert.deepEqual(await retained(board), range(4, 13));
    revision = replayed.json().revision;

    // List: bounded, newest-first and light.
    const firstPage = (await instance.inject({ url: `/api/boards/${board}/history?limit=4`, headers: basic })).json();
    assert.deepEqual(firstPage.items.map((item: { contentRevision: string }) => item.contentRevision), ['13', '12', '11', '10']);
    assert.equal(firstPage.items[0].current, true);
    assert.equal(firstPage.items[1].current, false);
    assert(firstPage.items.every((item: Record<string, unknown>) => !('doc' in item) && typeof item['createdAt'] === 'string'));
    assert.equal(firstPage.nextBefore, '10');
    const secondPage = (await instance.inject({ url: `/api/boards/${board}/history?limit=50&before=${firstPage.nextBefore}`, headers: basic })).json();
    assert.deepEqual(secondPage.items.map((item: { contentRevision: string }) => item.contentRevision), ['9', '8', '7', '6', '5', '4']);
    assert.equal(secondPage.nextBefore, null);
    assert.equal((await instance.inject({ url: `/api/boards/${board}/history?limit=0`, headers: basic })).statusCode, 400);
    assert.equal((await instance.inject({ url: `/api/boards/${board}/history?limit=9999`, headers: basic })).json().items.length, 10);

    // Owner isolation, including admins, for list/detail/restore/download.
    for (const who of [other, undefined]) {
      const headers = who ?? { origin };
      const expected = who ? 404 : 401;
      assert.equal((await instance.inject({ url: `/api/boards/${board}/history`, headers })).statusCode, expected);
      assert.equal((await instance.inject({ url: `/api/boards/${board}/history/5`, headers })).statusCode, expected);
    }
    assert.equal((await restore(other, board, 5, revision)).statusCode, 404);
    assert.equal((await current(basic, board)).name, 'v13');

    // Restore creates a new content revision and never rewrites history.
    const snapshot = (await instance.inject({ url: `/api/boards/${board}/history/5`, headers: basic })).json();
    assert.equal(snapshot.doc.name, 'v5');
    assert.equal((await restore(basic, board, 1, revision)).statusCode, 404, 'pruned revisions cannot be restored');
    const restoreId = randomUUID();
    const restored = await restore(basic, board, 5, revision, restoreId);
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json().contentRevision, '14');
    assert.equal(restored.json().revision, String(Number(revision) + 1));
    assert.equal(restored.json().restoredContentRevision, '5');
    assert.deepEqual((await restore(basic, board, 5, revision, restoreId)).json(), restored.json(), 'lost-response retry replays');
    assert.equal((await restore(basic, board, 6, revision, restoreId)).statusCode, 409, 'mutation id cannot be reused for another restore');
    assert.deepEqual(await retained(board), range(5, 14));
    const now = await current(basic, board);
    assert.equal(now.name, 'v5');
    assert.deepEqual(now.doc, snapshot.doc);
    const copy = (await instance.inject({ url: `/api/boards/${board}/history/14`, headers: basic })).json();
    assert.deepEqual(copy.doc, snapshot.doc);
    assert.deepEqual((await instance.inject({ url: `/api/boards/${board}/history/5`, headers: basic })).json().doc, snapshot.doc);
    await assert.rejects(
      database.pool.query("UPDATE board_history SET name='tampered', content='{}'::jsonb WHERE board_id=$1 AND content_revision=5", [board]),
      /immutable/,
      'retained snapshots cannot be edited, only pruned by retention',
    );
    assert.deepEqual((await instance.inject({ url: `/api/boards/${board}/history/5`, headers: basic })).json().doc, snapshot.doc);
    assert.equal((await restore(basic, board, 7, revision)).statusCode, 409, 'stale revision is rejected');
    assert.equal((await current(basic, board)).name, 'v5', 'conflict does not overwrite newer content');
    const unchanged = await restore(basic, board, 14, now.revision);
    assert.equal(unchanged.json().contentRevision, '14', 'restoring identical content consumes no revision');
    assert.deepEqual(await retained(board), range(5, 14));

    // Concurrent restores: exactly one wins and a later stale save cannot overwrite it.
    const races = await Promise.all([restore(basic, board, 8, now.revision), restore(basic, board, 9, now.revision)]);
    assert.deepEqual(races.map((response) => response.statusCode).sort(), [200, 409]);
    const winner = races.find((response) => response.statusCode === 200)?.json().restoredContentRevision as string;
    assert.equal((await current(basic, board)).name, `v${winner}`);
    assert.equal((await commit(basic, document(board, 'stale', { second: kept }), now.revision)).statusCode, 409);
    assert.equal((await current(basic, board)).name, `v${winner}`);
    assert.deepEqual(await retained(board), range(6, 15));
    assert.equal((await instance.inject({
      method: 'POST', url: `/api/boards/${board}/history/8/restore`, headers: { origin, cookie: basic.cookie },
      payload: { mutationId: randomUUID(), expectedRevision: now.revision },
    })).statusCode, 403, 'restore requires CSRF');

    // Admin: all history retained, restore respects attachment availability, role changes prune lazily.
    const adminBoard = randomUUID();
    assert.equal((await instance.inject({ method: 'POST', url: `/api/boards/${adminBoard}/staging`, headers: admin })).statusCode, 200);
    const old = await attachment(adminBoard, adminOwner, 'admin-old');
    saved = await commit(admin, document(adminBoard, 'a1', { file: old }), null);
    assert.equal(saved.statusCode, 200, saved.body);
    revision = saved.json().revision;
    for (let version = 2; version <= 12; version++) {
      saved = await commit(admin, document(adminBoard, `a${version}`), revision);
      assert.equal(saved.statusCode, 200, saved.body);
      revision = saved.json().revision;
    }
    assert.deepEqual(await retained(adminBoard), range(1, 12), 'admin history is not capped at ten');
    assert.equal((await instance.inject({ url: `/api/boards/${adminBoard}/history?limit=50`, headers: admin })).json().items.length, 12);
    const adminRestore = await restore(admin, adminBoard, 1, revision);
    assert.equal(adminRestore.statusCode, 200, adminRestore.body);
    assert.equal(adminRestore.json().contentRevision, '13');
    revision = adminRestore.json().revision;
    assert.equal((await database.pool.query('SELECT 1 FROM board_attachment_refs WHERE attachment_id=$1', [old.id])).rowCount, 1);
    assert.equal((await instance.inject({ url: `/api/boards/${adminBoard}/attachments/${old.id}`, headers: admin })).statusCode, 200);
    assert.equal((await instance.inject({ url: `/api/boards/${adminBoard}/attachments/${old.id}`, headers: other })).statusCode, 404);
    saved = await commit(admin, document(adminBoard, 'a14'), revision);
    revision = saved.json().revision;
    await database.pool.query("UPDATE board_attachments SET state='deleting' WHERE id=$1", [old.id]);
    const unavailable = await restore(admin, adminBoard, 13, revision);
    assert.equal(unavailable.statusCode, 422);
    assert.equal(unavailable.json().error.code, 'ATTACHMENT_UNAVAILABLE');
    assert.equal((await current(admin, adminBoard)).contentRevision, '14', 'rejected restore leaves the board unchanged');
    await database.pool.query("UPDATE board_attachments SET state='ready' WHERE id=$1", [old.id]);
    assert.deepEqual(await retained(adminBoard), range(1, 14));
    await database.pool.query("UPDATE users SET role='basic' WHERE id=$1", [adminOwner]);
    assert.deepEqual(await retained(adminBoard), range(1, 14), 'a role change alone does not prune');
    saved = await commit(admin, document(adminBoard, 'a15'), revision);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(await retained(adminBoard), range(6, 15), 'the next commit applies basic retention');
  } finally {
    await app?.close();
    try { await objectStore?.close(); } finally { await database.close(); }
  }
});
