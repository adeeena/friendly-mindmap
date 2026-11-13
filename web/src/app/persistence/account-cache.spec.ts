/**
 * @jest-environment node
 */
import 'fake-indexeddb/auto';
import { randomUUID, createHash } from 'node:crypto';
import { openDB } from 'idb';
import { createBoard, createNode, ROOT_KEY, SCHEMA_VERSION } from '../core/model';
import { BoardRecord, RevisionConflictError } from './board-repository';
import { ACCOUNT_CHUNK_BYTES, AccountBoardCache, PendingChangesError } from './account-cache';
import { NewerSchemaError } from './migrations';

function record(id: string, name = 'Cloud'): Omit<BoardRecord, 'revision'> {
  return {
    id, name, doc: createBoard(name, id), schemaVersion: SCHEMA_VERSION,
    updatedAt: Date.now(), camera: { x: 0, y: 0, zoom: 1 },
  };
}

describe('account-isolated offline cache', () => {
  it('coordinates durable leases with expiry, matching release and corruption protection', async () => {
    const cache = new AccountBoardCache(randomUUID(), 'admin');
    try {
      expect(await cache.syncLease('tab-a', 100, 15)).toBe(true);
      expect(await cache.syncLease('tab-b', 110, 15)).toBe(false);
      await cache.releaseSyncLease('tab-b');
      expect(await cache.syncLease('tab-b', 110, 15)).toBe(false);
      expect(await cache.syncLease('tab-b', 116, 15)).toBe(true);
      await cache.releaseSyncLease('tab-a');
      expect(await cache.syncLease('tab-a', 120, 15)).toBe(false);
      await cache.releaseSyncLease('tab-b');
      expect(await cache.syncLease('tab-a', 120, 15)).toBe(true);
      await cache.setMeta('syncLease', { owner: 'broken' });
      await expect(cache.syncLease('tab-a', 200, 15)).rejects.toThrow('Invalid account sync lease');
    } finally { await cache.close(); }
  });

  it('lists queued uploads and frees only bytes that no document, queued snapshot or server base references', async () => {
    const cache = new AccountBoardCache(randomUUID(), 'admin');
    try {
      const base = record(randomUUID());
      const keep = { id: randomUUID(), name: 'keep.txt', mime: 'text/plain', size: 2 };
      const orphan = { id: randomUUID(), name: 'orphan.txt', mime: 'text/plain', size: 2 };
      const fromServer = { id: randomUUID(), name: 'server.txt', mime: 'text/plain', size: 2 };
      const doc = createBoard('Files', base.id);
      doc.nodes['node'] = createNode({ id: 'node', attachments: [keep] });
      doc.children[ROOT_KEY] = ['node'];
      await cache.cacheRemote(base, '1');
      for (const meta of [keep, orphan]) {
        await cache.putAttachment(base.id, meta, new Blob(['ab']), { nodeId: 'node', attachments: [] });
      }
      const serverStream = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) { controller.enqueue(new TextEncoder().encode('cd')); controller.close(); },
      });
      await cache.receiveAttachment(base.id, fromServer, 'node', serverStream, new AbortController().signal, { serverReady: true });
      await cache.save({ ...base, doc, name: doc.name }, 1);
      expect((await cache.pendingAttachmentIds(base.id)).sort()).toEqual([keep.id, orphan.id].sort());
      await cache.collectUnreferencedAttachments(base.id);
      expect((await cache.listAttachmentIds(base.id)).sort()).toEqual([keep.id]);
      expect(await cache.pendingAttachmentIds(base.id)).toEqual([keep.id]);
    } finally { await cache.close(); }
  });

  it('copies immutable file chunks under fresh identities and cleans wholly unsent deletions', async () => {
    const cache = new AccountBoardCache(randomUUID(), 'admin');
    try {
      const source = randomUUID();
      const destination = randomUUID();
      const meta = { id: randomUUID(), name: 'file.bin', mime: 'application/octet-stream', size: ACCOUNT_CHUNK_BYTES + 3 };
      await cache.putAttachment(source, meta, new Blob([new Uint8Array(meta.size).fill(37)]), { nodeId: 'node', attachments: [] });
      const copy = { ...meta, id: randomUUID() };
      await cache.copyAttachment(source, meta.id, destination, copy, { nodeId: 'node', attachments: [copy] });
      const range = await cache.attachmentPart(destination, copy.id, ACCOUNT_CHUNK_BYTES - 1, 4);
      expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([37, 37, 37, 37]);
      await cache.deleteAttachment(source, meta.id);
      expect((await cache.getAttachment(destination, copy.id))?.size).toBe(meta.size);
      expect(await cache.attachmentReady(destination, copy.id)).toBe(false);
      await cache.save(record(destination), null);
      await cache.delete(destination);
      expect(await cache.pending()).toEqual([]);
      expect(await cache.listAttachmentIds(destination)).toEqual([]);
      await expect(cache.attachmentPart(destination, copy.id, 0, 1)).rejects.toThrow('not available');
    } finally { await cache.close(); }
  });

  it('rolls back copied chunks if a missing source chunk prevents staging', async () => {
    const cache = new AccountBoardCache(randomUUID(), 'admin');
    const id = randomUUID();
    const meta = { id: randomUUID(), name: 'file', mime: 'text/plain', size: 2 * ACCOUNT_CHUNK_BYTES };
    try {
      await cache.putAttachment(id, meta, new Blob([new Uint8Array(meta.size)]), { nodeId: 'node', attachments: [] });
      const db = await openDB(`better-mindmap-account-${cache.accountId}`, 1);
      await db.delete('chunks', [id, meta.id, 1]);
      const copy = { ...meta, id: randomUUID() };
      const destination = randomUUID();
      await expect(cache.copyAttachment(id, meta.id, destination, copy, { nodeId: 'node', attachments: [] })).rejects.toThrow('not available');
      expect(await cache.listAttachmentIds(destination)).toEqual([]);
      expect(await db.getAllKeys('chunks')).toEqual([[id, meta.id, 0]]);
      db.close();
    } finally { await cache.close(); }
  });

  it('rolls back both board and outbox when a transaction fails after snapshot writing', async () => {
    const cache = new AccountBoardCache(randomUUID(), 'basic');
    const id = randomUUID();
    const original = IDBObjectStore.prototype.put;
    const quota = jest.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'outbox') throw new DOMException('Device storage is full', 'QuotaExceededError');
      return original.apply(this, args);
    });
    try {
      await expect(cache.save(record(id), null)).rejects.toMatchObject({ name: 'QuotaExceededError' });
      expect(await cache.load(id)).toBeNull();
      expect(await cache.pending()).toEqual([]);
    } finally { quota.mockRestore(); await cache.close(); }
  });

  it('rejects a stale server acknowledgement without clearing pending work', async () => {
    const cache = new AccountBoardCache(randomUUID(), 'basic');
    const id = randomUUID();
    try {
      await cache.cacheRemote(record(id), '42');
      await cache.save(record(id, 'Pending'), 1);
      const pending = (await cache.pending())[0]!;
      await cache.beginMutation(pending.id);
      await expect(cache.acknowledge(pending.id, '41')).rejects.toThrow('stale');
      expect(await cache.pending()).toHaveLength(1);
      expect((await cache.load(id))?.serverRevision).toBe('42');
    } finally { await cache.close(); }
  });

  it('durably restores boards, preferences, chunk bytes and outbox without exposing another account', async () => {
    const accountId = randomUUID();
    const first = new AccountBoardCache(accountId, 'admin');
    const other = new AccountBoardCache(randomUUID(), 'basic');
    const id = randomUUID();
    const size = 9 * ACCOUNT_CHUNK_BYTES + 3;
    const blob = new Blob([new Uint8Array(size).fill(37)]);
    const wholeRead = jest.spyOn(blob, 'arrayBuffer').mockRejectedValue(new Error('Whole-file reads are forbidden'));
    const meta = { id: randomUUID(), name: 'large.bin', mime: 'application/octet-stream', size };
    try {
      await first.putAttachment(id, meta, blob, { nodeId: 'node', attachments: [] });
      expect(wholeRead).not.toHaveBeenCalled();
      const saved = await first.save(record(id), null);
      expect(saved).toEqual({ revision: 1, localDurability: 'persistent', cloud: { status: 'pending' } });
      await first.setMeta('theme', 'pale-rose');
      expect(await other.list()).toEqual([]);
      expect(await other.load(id)).toBeNull();
      expect(await other.getAttachment(id, meta.id)).toBeNull();
      expect(await other.getMeta('theme')).toBeUndefined();
      await first.close();
      const reopened = new AccountBoardCache(accountId, 'admin');
      try {
        expect((await reopened.load(id))?.name).toBe('Cloud');
        expect(await reopened.getMeta('theme')).toBe('pale-rose');
        expect(await reopened.pending()).toHaveLength(1);
        const hash = createHash('sha256');
        let actual = 0;
        for await (const chunk of reopened.readAttachmentChunks(id, meta.id)) {
          expect(chunk.byteLength).toBeLessThanOrEqual(ACCOUNT_CHUNK_BYTES);
          hash.update(chunk);
          actual += chunk.byteLength;
        }
        expect(actual).toBe(size);
        expect(hash.digest('hex')).toBe(createHash('sha256').update(new Uint8Array(size).fill(37)).digest('hex'));
        const small = { id: randomUUID(), name: 'small.txt', mime: 'text/plain', size: 3 };
        await reopened.putAttachment(id, small, new Blob(['abc']), { nodeId: 'small', attachments: [] });
        expect(await (await reopened.getAttachment(id, small.id))?.text()).toBe('abc');
      } finally { await reopened.close(); }
    } finally { await first.close(); await other.close(); }
  });

  it('older acknowledgements preserve newer edits and retry identities/revisions across reloads', async () => {
    const accountId = randomUUID();
    const cache = new AccountBoardCache(accountId, 'basic');
    const id = randomUUID();
    try {
      await cache.save(record(id, 'First'), null);
      const first = (await cache.pending())[0]!;
      const sending = await cache.beginMutation(first.id);
      expect(sending.expectedRevision).toBeNull();
      await cache.save(record(id, 'Second'), 1);
      await expect(cache.cacheRemote(record(id, 'Remote'), '1')).rejects.toBeInstanceOf(PendingChangesError);
      await cache.acknowledge(first.id, '1');
      const newer = await cache.load(id);
      expect(newer?.name).toBe('Second');
      expect(newer?.revision).toBe(2);
      expect(newer?.acknowledgedSequence).toBe(1);
      expect(newer?.base?.name).toBe('First');
      const second = (await cache.pending())[0]!;
      const next = await cache.beginMutation(second.id);
      expect(next.expectedRevision).toBe('1');
      await cache.close();
      const reloaded = new AccountBoardCache(accountId, 'basic');
      try {
        expect(await reloaded.beginMutation(second.id)).toEqual(next);
        await reloaded.acknowledge(second.id, '2');
        expect(await reloaded.pending()).toEqual([]);
        expect((await reloaded.load(id))?.acknowledgedSequence).toBe(2);
        await expect(reloaded.save(record(id), 1)).rejects.toBeInstanceOf(RevisionConflictError);
        await expect(reloaded.save(record(id), null)).rejects.toBeInstanceOf(RevisionConflictError);
        await reloaded.delete(id);
        expect(await reloaded.load(id)).toBeNull();
        expect(await reloaded.list()).toEqual([]);
        const deletion = (await reloaded.pending())[0]!;
        expect(deletion.kind).toBe('delete');
        expect((await reloaded.beginMutation(deletion.id)).expectedRevision).toBe('2');
      } finally { await reloaded.close(); }
    } finally { await cache.close(); }
  });

  it('uses atomic queue ordering, cancels unpublished boards and handles remote-first deletion', async () => {
    const cache = new AccountBoardCache(randomUUID(), 'basic');
    try {
      const local = randomUUID();
      await cache.save(record(local), null);
      await cache.save(record(local, 'Renamed'), 1);
      expect(await cache.pending()).toHaveLength(1);
      await cache.delete(local);
      expect(await cache.pending()).toEqual([]);
      expect(await cache.list()).toEqual([]);
      await expect(cache.save(record(local), null)).rejects.toBeInstanceOf(RevisionConflictError);
    } finally { await cache.close(); }
    const remote = new AccountBoardCache(randomUUID(), 'basic');
    try {
      const id = randomUUID();
      await remote.cacheRemote(record(id), '42');
      await remote.save(record(id, 'Queued'), 1);
      const first = (await remote.pending())[0]!;
      await remote.beginMutation(first.id);
      await remote.save(record(id, 'Later'), 2);
      const pending = await remote.pending();
      await expect(remote.beginMutation(pending[1]!.id)).rejects.toThrow('Earlier board mutations');
      await remote.acknowledge(first.id, '43');
      const second = (await remote.pending())[0]!;
      await remote.beginMutation(second.id);
      await remote.acknowledge(second.id, '44');
      await remote.delete(id);
      const deletion = (await remote.pending())[0]!;
      expect((await remote.beginMutation(deletion.id)).expectedRevision).toBe('44');
    } finally { await remote.close(); }
  });

  it('reports quota failures, removes incomplete chunks and never queues a successful file', async () => {
    const cache = new AccountBoardCache(randomUUID(), 'admin');
    const id = randomUUID();
    const meta = { id: randomUUID(), name: 'file.bin', mime: 'application/octet-stream', size: ACCOUNT_CHUNK_BYTES + 1 };
    const original = IDBObjectStore.prototype.put;
    const quota = jest.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'chunks') throw new DOMException('Device storage is full', 'QuotaExceededError');
      return original.apply(this, args);
    });
    try {
      await expect(cache.putAttachment(id, meta, new Blob([new Uint8Array(meta.size)]),
        { nodeId: 'node', attachments: [] })).rejects.toMatchObject({ name: 'QuotaExceededError' });
      expect(await cache.listAttachmentIds(id)).toEqual([]);
      expect(await cache.pending()).toEqual([]);
      expect(await cache.getAttachment(id, meta.id)).toBeNull();
    } finally { quota.mockRestore(); await cache.close(); }
  });

  it('preserves newer board/cache schemas rather than resetting or overwriting them', async () => {
    const account = randomUUID();
    const cache = new AccountBoardCache(account, 'basic');
    const id = randomUUID();
    await cache.cacheRemote({ ...record(id), schemaVersion: SCHEMA_VERSION + 1 }, '1');
    await expect(cache.save(record(id), 1)).rejects.toBeInstanceOf(NewerSchemaError);
    expect((await cache.load(id))?.schemaVersion).toBe(SCHEMA_VERSION + 1);
    expect(await cache.pending()).toEqual([]);
    await cache.close();
    const db = await openDB(`better-mindmap-account-${account}`, 2);
    await db.put('meta', 'preserve', 'future');
    db.close();
    const unsupported = new AccountBoardCache(account, 'basic');
    await expect(unsupported.list()).rejects.toMatchObject({ name: 'VersionError' });
    const preserved = await openDB(`better-mindmap-account-${account}`);
    expect(await preserved.get('meta', 'future')).toBe('preserve');
    preserved.close();
  });
});
