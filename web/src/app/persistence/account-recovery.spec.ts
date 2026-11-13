/**
 * @jest-environment node
 */
import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { openDB } from 'idb';
import { createBoard, createNode, ROOT_KEY, SCHEMA_VERSION } from '../core/model';
import { AccountBoardCache, ACCOUNT_CHUNK_BYTES, PendingChangesError } from './account-cache';
import { BoardRecord } from './board-repository';
import { migrateBoard } from './migrations';

function record(id = randomUUID(), name = 'Base'): Omit<BoardRecord, 'revision'> {
  return { id, name, doc: createBoard(name, id), camera: { x: 0, y: 0, zoom: 1 }, schemaVersion: SCHEMA_VERSION, updatedAt: Date.now() };
}

describe('transactional remote conflict recovery', () => {
  let cache: AccountBoardCache;
  beforeEach(() => { cache = new AccountBoardCache(randomUUID(), 'admin'); });
  afterEach(async () => { await cache.close(); });

  it('preserves both devices with fresh attachment identities and bytes, and never duplicates recovery after restart', async () => {
    const base = record();
    await cache.cacheRemote(base, '1');
    const doc = createBoard('Local edits', base.id);
    const meta = { id: randomUUID(), name: 'local.bin', mime: 'application/octet-stream', size: ACCOUNT_CHUNK_BYTES + 3 };
    doc.nodes['node'] = createNode({ id: 'node', attachments: [meta] });
    doc.children[ROOT_KEY] = ['node'];
    await cache.putAttachment(base.id, meta, new Blob([new Uint8Array(meta.size).fill(37)]), { nodeId: 'node', attachments: [] });
    await cache.save({ ...base, doc, name: doc.name }, 1);
    const pending = (await cache.pending())[0]!;
    await cache.beginMutation(pending.id);
    const remote = { record: record(base.id, 'Other device'), revision: '2' };
    const changed = await cache.reconcileRemote(remote, 2, true, (name) => name + ' recovered');
    expect(changed.notice).toEqual({ name: 'Local edits recovered', deletion: false });
    expect((await cache.load(base.id))?.name).toBe('Other device');
    const copy = (await cache.list()).find((board) => board.id !== base.id)!;
    const recovered = migrateBoard(await cache.load(copy.id));
    const attachment = recovered.doc.nodes['node']!.attachments![0]!;
    expect(attachment.id).not.toBe(meta.id);
    expect((await cache.getAttachment(copy.id, attachment.id))?.size).toBe(meta.size);
    expect([...new Uint8Array(await (await cache.attachmentPart(copy.id, attachment.id, ACCOUNT_CHUNK_BYTES - 1, 4)).arrayBuffer())]).toEqual([37, 37, 37, 37]);
    expect(await cache.pending()).toHaveLength(1);
    expect((await cache.beginMutation((await cache.pending())[0]!.id)).expectedRevision).toBeNull();
    await cache.close();
    cache = new AccountBoardCache(cache.accountId, 'admin');
    await expect(cache.reconcileRemote(remote, 2, true, (name) => name + ' recovered')).rejects.toBeInstanceOf(PendingChangesError);
    expect(await cache.list()).toHaveLength(2);
    expect(await cache.getMeta('syncNotice')).toEqual(changed.notice);
  });

  it('honors remote tombstones while keeping offline edits under a separate ID', async () => {
    const base = record();
    await cache.cacheRemote(base, '7');
    await cache.save(record(base.id, 'Offline edits'), 1);
    await cache.reconcileRemote({ id: base.id, revision: '8', deleted: true }, 2, true, (name) => name + ' recovered');
    expect(await cache.load(base.id)).toBeNull();
    expect((await cache.syncBoard(base.id))?.deleted).toBe(true);
    expect(await cache.list()).toHaveLength(1);
    const copy = (await cache.list())[0]!;
    expect(copy.id).not.toBe(base.id);
    expect(copy.name).toBe('Offline edits recovered');
    expect((await cache.pending())[0]?.boardId).toBe(copy.id);
  });

  it('cancels a stale offline deletion without deleting the newer remote board and retains the local version', async () => {
    const base = record();
    await cache.cacheRemote(base, '5');
    await cache.delete(base.id);
    const change = await cache.reconcileRemote({ record: record(base.id, 'New remote content'), revision: '6' },
      2, true, (name) => name + ' recovered');
    expect(change.notice).toEqual({ name: 'Base recovered', deletion: true });
    expect((await cache.load(base.id))?.name).toBe('New remote content');
    expect((await cache.list()).map((board) => board.name).sort()).toEqual(['Base recovered', 'New remote content']);
    expect((await cache.pending()).map((op) => op.kind)).toEqual(['save']);
  });

  it('rebases camera-only work across JSONB key ordering without creating a content conflict copy', async () => {
    const base = record();
    await cache.cacheRemote(base, '1');
    const doc = Object.fromEntries(Object.entries(migrateBoard(base).doc).reverse());
    await cache.save({ ...base, doc, camera: { x: 200, y: 100, zoom: 2 } }, 1);
    const changed = await cache.reconcileRemote({ record: record(base.id, 'Other content'), revision: '2' }, 2, true, (name) => name + ' copy');
    expect(changed.notice).toBeUndefined();
    expect(await cache.list()).toHaveLength(1);
    const current = await cache.load(base.id);
    expect(current?.name).toBe('Other content');
    expect(current?.camera).toEqual({ x: 200, y: 100, zoom: 2 });
    const pending = (await cache.pending())[0]!;
    expect((await cache.beginMutation(pending.id)).expectedRevision).toBe('2');
  });

  it('rolls back recovery entirely on quota failure and never overwrites a concurrent local revision', async () => {
    const base = record();
    await cache.cacheRemote(base, '1');
    await cache.save(record(base.id, 'Pending'), 1);
    const before = await cache.pending();
    const original = IDBObjectStore.prototype.add;
    const quota = jest.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'boards') throw new DOMException('Full', 'QuotaExceededError');
      return original.apply(this, args);
    });
    try {
      await expect(cache.reconcileRemote({ record: record(base.id, 'Remote'), revision: '2' }, 2, true, (name) => name + ' copy')).rejects.toMatchObject({ name: 'QuotaExceededError' });
      expect(await cache.pending()).toEqual(before);
      expect((await cache.load(base.id))?.name).toBe('Pending');
      expect(await cache.list()).toHaveLength(1);
    } finally { quota.mockRestore(); }
    await cache.save(record(base.id, 'Newer pending'), 2);
    await expect(cache.reconcileRemote({ record: record(base.id, 'Remote'), revision: '2' }, 2, true, (name) => name + ' copy')).rejects.toBeInstanceOf(PendingChangesError);
    expect((await cache.load(base.id))?.name).toBe('Newer pending');
  });

  it('preserves now-over-limit bytes after a role downgrade without granting upload privileges', async () => {
    const base = record();
    const doc = createBoard('Admin work', base.id);
    const meta = { id: randomUUID(), name: 'large', mime: 'application/octet-stream', size: 5_242_881 };
    doc.nodes['node'] = createNode({ id: 'node', attachments: [meta] });
    doc.children[ROOT_KEY] = ['node'];
    await cache.cacheRemote(base, '1');
    await cache.putAttachment(base.id, meta, new Blob([new Uint8Array(meta.size)]), { nodeId: 'node', attachments: [] });
    await cache.save({ ...base, doc, name: doc.name }, 1);
    await cache.close();
    cache = new AccountBoardCache(cache.accountId, 'basic');
    await cache.reconcileRemote({ record: record(base.id, 'Remote'), revision: '2' }, 2, true, (name) => name + ' recovered');
    const copy = (await cache.list()).find((board) => board.id !== base.id)!;
    const copyDoc = migrateBoard(await cache.load(copy.id)).doc;
    const copied = copyDoc.nodes['node']!.attachments![0]!;
    expect((await cache.getAttachment(copy.id, copied.id))?.size).toBe(meta.size);
    expect((await cache.pending())[0]?.boardId).toBe(copy.id);
    expect(cache.attachmentRole).toBe('basic');
  });

  it('never exposes incomplete or oversized downloaded recovery bytes as available', async () => {
    const id = randomUUID();
    const meta = { id: randomUUID(), name: 'file', mime: 'text/plain', size: 3 };
    const stream = (text: string) => new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); },
    });
    await expect(cache.receiveAttachment(id, meta, 'node', stream('ab'), new AbortController().signal)).rejects.toThrow('incomplete');
    expect(await cache.listAttachmentIds(id)).toEqual([]);
    await expect(cache.getAttachment(id, meta.id)).rejects.toThrow('not available');
    await expect(cache.receiveAttachment(id, meta, 'node', stream('abcd'), new AbortController().signal)).rejects.toThrow('exceeds');
    expect(await cache.listAttachmentIds(id)).toEqual([]);
    await cache.receiveAttachment(id, meta, 'node', stream('abc'), new AbortController().signal);
    expect(await (await cache.getAttachment(id, meta.id))?.text()).toBe('abc');
  });

  it('retains uncached references and receives recovery downloads in bounded chunks without publishing incomplete bytes', async () => {
    const base = record();
    const doc = createBoard('Remote file', base.id);
    const meta = { id: randomUUID(), name: 'file.bin', mime: 'application/octet-stream', size: ACCOUNT_CHUNK_BYTES + 3 };
    doc.nodes['node'] = createNode({ id: 'node', attachments: [meta] });
    doc.children[ROOT_KEY] = ['node'];
    await cache.cacheRemote({ ...base, doc, name: doc.name }, '1');
    await cache.save({ ...base, doc: { ...doc, name: 'Local' }, name: 'Local' }, 1);
    await cache.reconcileRemote({ record: record(base.id, 'Remote'), revision: '2' }, 2, true, (name) => name + ' copy');
    const copy = (await cache.list()).find((board) => board.id !== base.id)!;
    const copyDoc = migrateBoard(await cache.load(copy.id)).doc;
    const attachment = copyDoc.nodes['node']!.attachments![0]!;
    expect(await cache.attachmentSource(copy.id, attachment.id)).toEqual({ boardId: base.id, id: meta.id });
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(new Uint8Array(31).fill(37));
        controller.enqueue(new Uint8Array(meta.size - 31).fill(37));
        controller.close();
      },
    });
    await cache.receiveAttachment(copy.id, attachment, 'node', stream, new AbortController().signal);
    expect(await cache.attachmentSource(copy.id, attachment.id)).toBeNull();
    expect((await cache.getAttachment(copy.id, attachment.id))?.size).toBe(meta.size);
    const db = await openDB(`better-mindmap-account-${cache.accountId}`, 1);
    const chunks: { data: ArrayBuffer }[] = await db.getAll('chunks');
    expect(chunks.map((chunk) => chunk.data.byteLength)).toEqual([ACCOUNT_CHUNK_BYTES, 3]);
    db.close();
  });
});
