/**
 * @jest-environment node
 */
import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { createBoard, createNode, ROOT_KEY, SCHEMA_VERSION } from '../core/model';
import { AccountBoardCache } from './account-cache';
import { AccountSync, SyncState } from './account-sync';
import { AuthSession, CloudRequestError } from './auth-client';
import { BoardRecord } from './board-repository';
import { CloudBoardClient, CloudProtocolError } from './cloud-board-client';

function record(id = randomUUID(), name = 'Queued'): Omit<BoardRecord, 'revision'> {
  return { id, name, doc: createBoard(name, id), schemaVersion: SCHEMA_VERSION,
    updatedAt: Date.now(), camera: { x: 0, y: 0, zoom: 1 } };
}
function session(id: string): AuthSession {
  return { account: { id, role: 'admin', username: 'test', display_name: 'Test' },
    sessionId: randomUUID(), csrfToken: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00Z' };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe('durable account replay', () => {
  const caches: AccountBoardCache[] = [];
  const coordinators: AccountSync[] = [];
  function setup(account = randomUUID(), client = {
    stage: jest.fn().mockResolvedValue(undefined),
    upload: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue('1'),
    list: jest.fn().mockResolvedValue([]),
    load: jest.fn().mockResolvedValue(null),
    download: jest.fn(),
  }, locks: Pick<LockManager, 'request'> | null = null) {
    const cache = new AccountBoardCache(account, 'admin');
    const states: SyncState[] = [];
    const current = jest.fn().mockResolvedValue(session(account));
    const events = new EventTarget();
    const recovered = jest.fn();
    const changed = jest.fn().mockResolvedValue(undefined);
    const transfer = jest.fn();
    const sync = new AccountSync(cache, {
      current, state: (state) => states.push(state), verified: jest.fn(), client, locks, events, channel: null, recovered, changed, transfer,
    });
    caches.push(cache);
    coordinators.push(sync);
    return { cache, sync, states, current, client, events, recovered, changed, transfer };
  }
  afterEach(async () => {
    await Promise.all(coordinators.splice(0).map((sync) => sync.stop()));
    await Promise.all(caches.splice(0).map((cache) => cache.close()));
    jest.useRealTimers();
  });

  it('replays a lost create acknowledgement with identical identity/payload after reload, without clearing newer edits', async () => {
    const first = setup();
    const board = record();
    await first.cache.save(board, null);
    const entered = gate();
    const finish = gate();
    first.client.commit.mockImplementationOnce(async () => {
      entered.release();
      await finish.promise;
      throw new TypeError('Response lost after commit');
    });
    const replay = first.sync.synchronize();
    await entered.promise;
    await first.cache.save({ ...board, name: 'Newer', doc: createBoard('Newer', board.id) }, 1);
    finish.release();
    await replay;
    expect(first.states.at(-1)).toBe('retrying');
    const frozen = first.client.commit.mock.calls[0]![0];
    expect((await first.cache.pending())[0]).toEqual(frozen);
    await first.sync.stop();
    await first.cache.close();
    const reopened = setup(first.cache.accountId);
    reopened.client.commit.mockResolvedValueOnce('1').mockResolvedValueOnce('2');
    await reopened.sync.synchronize();
    expect(reopened.client.commit.mock.calls[0]![0]).toEqual(frozen);
    expect(reopened.client.commit.mock.calls[1]![0]).toMatchObject({ expectedRevision: '1', sequence: 2 });
    expect((await reopened.cache.load(board.id))?.name).toBe('Newer');
    expect((await reopened.cache.load(board.id))?.acknowledgedSequence).toBe(2);
    expect(await reopened.cache.pending()).toEqual([]);
    expect(reopened.states.at(-1)).toBe('idle');
  });

  it('serializes competing tabs with the durable lease even when Web Locks are unavailable', async () => {
    const first = setup();
    const board = record();
    await first.cache.save(board, null);
    const entered = gate();
    const finish = gate();
    first.client.commit.mockImplementationOnce(async () => { entered.release(); await finish.promise; return '1'; });
    const second = setup(first.cache.accountId);
    const replay = first.sync.synchronize();
    await entered.promise;
    await second.sync.synchronize();
    expect(second.client.commit).not.toHaveBeenCalled();
    expect(second.states.at(-1)).toBe('pending');
    finish.release();
    await replay;
    await second.sync.synchronize();
    expect(second.client.commit).not.toHaveBeenCalled();
    expect(second.states.at(-1)).toBe('idle');
    expect(await second.cache.pending()).toEqual([]);
  });

  it('uses the account-specific Web Lock as well as a recoverable lease', async () => {
    const request = jest.fn(async (_name, _options, callback) => callback(null));
    const fixture = setup(randomUUID(), undefined, { request });
    await fixture.cache.save(record(), null);
    await fixture.sync.synchronize();
    expect(request.mock.calls[0]![0]).toBe(`better-mindmap-sync:${fixture.cache.accountId}`);
    expect(request.mock.calls[0]![1]).toMatchObject({ ifAvailable: true, mode: 'exclusive' });
    expect(fixture.client.commit).not.toHaveBeenCalled();
    expect(fixture.states.at(-1)).toBe('pending');
  });

  it('stages and finalizes files before publishing, then skips finalized files on a lost commit response', async () => {
    const fixture = setup();
    const doc = createBoard('With bytes');
    const meta = { id: randomUUID(), name: 'file.bin', mime: 'application/octet-stream', size: 9 * 1024 * 1024 + 3 };
    doc.nodes['node'] = createNode({ id: 'node', attachments: [meta] });
    doc.children[ROOT_KEY] = ['node'];
    await fixture.cache.putAttachment(doc.id, meta, new Blob([new Uint8Array(meta.size).fill(37)]), { nodeId: 'node', attachments: [] });
    await fixture.cache.save({ ...record(doc.id), doc, name: doc.name }, null);
    const order: string[] = [];
    fixture.client.stage.mockImplementation(async () => { order.push('stage'); });
    fixture.client.upload.mockImplementation(async (_board, _node, _meta, _session, _signal, readPart, check) => {
      order.push('upload');
      await check();
      const part: Blob = await readPart(1024 * 1024 - 1, 8 * 1024 * 1024);
      expect(part.size).toBe(8 * 1024 * 1024);
      expect(new Uint8Array(await part.arrayBuffer()).every((byte) => byte === 37)).toBe(true);
    });
    fixture.client.commit.mockImplementationOnce(async () => { order.push('commit'); throw new TypeError('Lost response'); });
    await fixture.sync.synchronize();
    expect(order).toEqual(['stage', 'upload', 'commit']);
    expect(await fixture.cache.attachmentReady(doc.id, meta.id)).toBe(true);
    await fixture.sync.synchronize();
    expect(fixture.client.upload).toHaveBeenCalledTimes(1);
    expect(fixture.client.stage).toHaveBeenCalledTimes(1);
    expect(await fixture.cache.pending()).toEqual([]);
  });

  it('never commits a board if its attachment upload was interrupted', async () => {
    const fixture = setup();
    const doc = createBoard('Pending');
    const meta = { id: randomUUID(), name: 'file', mime: 'text/plain', size: 1 };
    doc.nodes['node'] = createNode({ id: 'node', attachments: [meta] });
    doc.children[ROOT_KEY] = ['node'];
    await fixture.cache.putAttachment(doc.id, meta, new Blob(['x']), { nodeId: 'node', attachments: [] });
    await fixture.cache.save({ ...record(doc.id), doc, name: doc.name }, null);
    fixture.client.upload.mockRejectedValueOnce(new TypeError('Disconnected'));
    await fixture.sync.synchronize();
    expect(fixture.client.commit).not.toHaveBeenCalled();
    expect(await fixture.cache.attachmentReady(doc.id, meta.id)).toBe(false);
    expect(await fixture.cache.pending()).toHaveLength(1);
    await fixture.sync.synchronize();
    expect(await fixture.cache.pending()).toEqual([]);
  });

  it.each([401, 403, 409, 410, 413, 422, 400])('preserves pending work and pauses on HTTP %s', async (status) => {
    const fixture = setup();
    await fixture.cache.save(record(), null);
    fixture.client.commit.mockRejectedValue(new CloudRequestError(status));
    await fixture.sync.synchronize();
    expect(await fixture.cache.pending()).toHaveLength(1);
    expect(fixture.states.at(-1)).toBe([401, 403].includes(status) ? 'auth-required'
      : [409, 410].includes(status) ? 'conflict' : [413, 422].includes(status) ? 'policy-error' : 'error');
  });

  it('lets a corrected local snapshot replace a definitively policy-rejected mutation, without changing uncertain retries', async () => {
    const fixture = setup();
    const board = record();
    await fixture.cache.save(board, null);
    fixture.client.commit.mockRejectedValueOnce(new CloudRequestError(422, 'ATTACHMENT_SIZE'));
    await fixture.sync.synchronize();
    expect((await fixture.cache.pending())[0]?.state).toBe('queued');
    await fixture.cache.save(record(board.id, 'Corrected local work'), 1);
    await fixture.sync.synchronize();
    expect(fixture.client.commit.mock.calls[1]![0].record?.name).toBe('Corrected local work');
    expect(fixture.client.commit.mock.calls[1]![0].mutationId).not.toBe(fixture.client.commit.mock.calls[0]![0].mutationId);
    expect(await fixture.cache.pending()).toEqual([]);
  });

  it('cancels a newly deleted unpublished board when its uncertain creation is definitively rejected', async () => {
    const fixture = setup();
    const board = record();
    const meta = { id: randomUUID(), name: 'file', mime: 'text/plain', size: 3 };
    await fixture.cache.putAttachment(board.id, meta, new Blob(['abc']), { nodeId: 'node', attachments: [] });
    await fixture.cache.save(board, null);
    fixture.client.commit.mockImplementationOnce(async () => {
      await fixture.cache.delete(board.id);
      throw new CloudRequestError(422, 'ATTACHMENT_SIZE');
    });
    await fixture.sync.synchronize();
    expect(await fixture.cache.pending()).toEqual([]);
    expect(await fixture.cache.listAttachmentIds(board.id)).toEqual([]);
    expect(await fixture.cache.load(board.id)).toBeNull();
    expect(fixture.states.at(-1)).toBe('pending');
    await fixture.sync.synchronize();
    expect(fixture.states.at(-1)).toBe('idle');
  });

  it('reports upload progress and lets a user cancellation supersede the frozen snapshot without losing later work', async () => {
    const fixture = setup();
    const board = record();
    const meta = { id: randomUUID(), name: 'big.bin', mime: 'application/octet-stream', size: 2 };
    const doc = createBoard('With file', board.id);
    doc.nodes['node'] = createNode({ id: 'node', attachments: [meta] });
    doc.children[ROOT_KEY] = ['node'];
    await fixture.cache.putAttachment(board.id, meta, new Blob(['ab']), { nodeId: 'node', attachments: [] });
    await fixture.cache.save({ ...board, doc, name: doc.name }, null);
    const entered = gate();
    fixture.client.upload.mockImplementationOnce(async (_b, _n, _m, _s, signal: AbortSignal, _read, _check, progress: (loaded: number) => void) => {
      progress(1);
      entered.release();
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    const replay = fixture.sync.synchronize();
    await entered.promise;
    await fixture.cache.save({ ...board, name: 'Cancelled', doc: createBoard('Cancelled', board.id) }, 1);
    fixture.sync.cancelTransfer(meta.id);
    await replay;
    expect(fixture.transfer).toHaveBeenCalledWith({ attachmentId: meta.id, kind: 'upload', loaded: 1, total: 2 });
    expect(fixture.transfer).toHaveBeenLastCalledWith(expect.objectContaining({ attachmentId: meta.id, done: true }));
    expect(fixture.states.at(-1)).toBe('pending');
    await fixture.sync.synchronize();
    expect(fixture.client.commit.mock.calls.at(-1)![0].record?.name).toBe('Cancelled');
    expect(await fixture.cache.pending()).toEqual([]);
  });

  it('downloads a cloud-only file into the private cache with progress and marks it already on the server', async () => {
    const fixture = setup();
    const board = record();
    const meta = { id: randomUUID(), name: 'remote.txt', mime: 'text/plain', size: 2 };
    const doc = createBoard('Remote', board.id);
    doc.nodes['node'] = createNode({ id: 'node', attachments: [meta] });
    doc.children[ROOT_KEY] = ['node'];
    await fixture.cache.cacheRemote({ ...board, doc, name: doc.name }, '1');
    fixture.client.download.mockResolvedValueOnce(new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) { controller.enqueue(new TextEncoder().encode('ab')); controller.close(); },
    }));
    await fixture.sync.fetchAttachment(board.id, meta, 'node');
    expect(fixture.client.download.mock.calls[0]![0]).toBe(board.id);
    expect(await (await fixture.cache.getAttachment(board.id, meta.id))?.text()).toBe('ab');
    expect(await fixture.cache.pendingAttachmentIds(board.id)).toEqual([]);
    expect(fixture.transfer).toHaveBeenCalledWith({ attachmentId: meta.id, kind: 'download', loaded: 2, total: 2 });
    fixture.client.download.mockRejectedValueOnce(new CloudRequestError(404));
    const missing = { ...meta, id: randomUUID() };
    await expect(fixture.sync.fetchAttachment(board.id, missing, 'node')).rejects.toBeInstanceOf(CloudRequestError);
    expect(await fixture.cache.listAttachmentIds(board.id)).toEqual([meta.id]);
  });

  it('reports cloud acknowledgement of a specific local revision only after it is committed, never while offline or signed out', async () => {
    const fixture = setup();
    const board = record();
    await fixture.cache.save(board, null);
    expect(await fixture.sync.flushBoard(board.id, 1)).toBe('acknowledged');
    expect(fixture.client.commit).toHaveBeenCalledTimes(1);
    await fixture.cache.save({ ...board, name: 'Second', doc: createBoard('Second', board.id) }, 1);
    fixture.client.commit.mockRejectedValueOnce(new TypeError('offline'));
    expect(await fixture.sync.flushBoard(board.id, 2)).toBe('retrying');
    fixture.current.mockResolvedValueOnce(null);
    expect(await fixture.sync.flushBoard(board.id, 2)).toBe('auth-required');
    expect(await fixture.cache.pending()).toHaveLength(1);
    fixture.client.commit.mockResolvedValue('2');
    expect(await fixture.sync.flushBoard(board.id, 2)).toBe('acknowledged');
    expect(await fixture.cache.pending()).toEqual([]);
  });

  it('requires a matching live session before replay, never submitting A work with B credentials', async () => {
    const fixture = setup();
    await fixture.cache.save(record(), null);
    fixture.current.mockResolvedValueOnce(session(randomUUID()));
    await fixture.sync.synchronize();
    expect(fixture.client.commit).not.toHaveBeenCalled();
    expect((await fixture.cache.pending())[0]?.state).toBe('queued');
    expect(fixture.states.at(-1)).toBe('auth-required');
    await fixture.sync.synchronize();
    expect(await fixture.cache.pending()).toEqual([]);
  });

  it('does not acknowledge delayed responses after the workspace stops', async () => {
    const fixture = setup();
    await fixture.cache.save(record(), null);
    const entered = gate();
    const finish = gate();
    fixture.client.commit.mockImplementationOnce(async () => { entered.release(); await finish.promise; return '1'; });
    const replay = fixture.sync.synchronize();
    await entered.promise;
    const stopping = fixture.sync.stop();
    finish.release();
    await Promise.all([replay, stopping]);
    expect(await fixture.cache.pending()).toHaveLength(1);
  });

  it('cancels wholly unsent creations and replays remote rename, duplicate and delete in order', async () => {
    const fixture = setup();
    const cancelled = record();
    await fixture.cache.save(cancelled, null);
    await fixture.cache.delete(cancelled.id);
    const remote = record();
    await fixture.cache.cacheRemote(remote, '9');
    await fixture.cache.save({ ...remote, name: 'Renamed', doc: createBoard('Renamed', remote.id) }, 1);
    const copy = record(randomUUID(), 'Copy');
    await fixture.cache.save(copy, null);
    await fixture.cache.delete(remote.id);
    fixture.client.commit.mockResolvedValueOnce('10').mockResolvedValueOnce('1').mockResolvedValueOnce('11');
    await fixture.sync.synchronize();
    expect(fixture.client.commit.mock.calls.map(([op]) => [op.boardId, op.kind, op.expectedRevision])).toEqual([
      [remote.id, 'save', '9'], [copy.id, 'save', null], [remote.id, 'delete', '10'],
    ]);
    expect((await fixture.cache.list()).map((board) => board.id)).toEqual([copy.id]);
    expect(await fixture.cache.pending()).toEqual([]);
  });

  it('keeps bounded exponential retries despite new local writes, and reconnect requests immediate replay', async () => {
    const fixture = setup();
    await fixture.cache.save(record(), null);
    const scheduled = jest.spyOn(globalThis, 'setTimeout');
    fixture.client.commit.mockRejectedValue(new CloudRequestError(503));
    fixture.sync.start();
    await fixture.sync.synchronize();
    expect(scheduled.mock.calls.at(-1)?.[1]).toBeGreaterThanOrEqual(1000);
    expect(scheduled.mock.calls.at(-1)?.[1]).toBeLessThan(1250);
    await fixture.cache.save(record(), null);
    expect(scheduled.mock.calls.at(-1)?.[1]).toBeGreaterThanOrEqual(1000);
    await fixture.sync.synchronize();
    expect(scheduled.mock.calls.at(-1)?.[1]).toBeGreaterThanOrEqual(2000);
    fixture.events.dispatchEvent(new Event('online'));
    expect(scheduled.mock.calls.at(-1)?.[1]).toBe(0);
    scheduled.mockRestore();
  });

  it('retries when a newly coalesced save replaces the selected queued operation before it is claimed', async () => {
    const fixture = setup();
    const board = record();
    await fixture.cache.save(board, null);
    const begin = fixture.cache.beginMutation.bind(fixture.cache);
    jest.spyOn(fixture.cache, 'beginMutation').mockImplementationOnce(async (id) => {
      await fixture.cache.save(record(board.id, 'Latest coalesced work'), 1);
      return begin(id);
    });
    await fixture.sync.synchronize();
    expect(fixture.states.at(-1)).toBe('pending');
    expect(fixture.client.commit).not.toHaveBeenCalled();
    await fixture.sync.synchronize();
    expect(fixture.client.commit.mock.calls[0]![0].record?.name).toBe('Latest coalesced work');
    expect(await fixture.cache.pending()).toEqual([]);
  });

  it('refreshes clean remote boards and broadcasts revisions without overwriting pending local work', async () => {
    const fixture = setup();
    const remote = record();
    fixture.client.list.mockResolvedValue([{ id: remote.id, name: remote.name, revision: '2', updatedAt: 1, deletedAt: null }]);
    fixture.client.load.mockResolvedValue({ record: remote, revision: '2' });
    await fixture.sync.synchronize();
    expect((await fixture.cache.load(remote.id))?.serverRevision).toBe('2');
    expect(fixture.changed).toHaveBeenCalledWith({ id: remote.id, revision: 1, deleted: false });
    expect(fixture.client.commit).not.toHaveBeenCalled();
  });

  it('recovers a rejected content commit, then uploads only the separate copy', async () => {
    const fixture = setup();
    const base = record();
    await fixture.cache.cacheRemote(base, '1');
    const local = record(base.id, 'Device A');
    await fixture.cache.save(local, 1);
    fixture.client.commit.mockRejectedValueOnce(new CloudRequestError(409, 'REVISION_CONFLICT')).mockResolvedValueOnce('1');
    fixture.client.load.mockResolvedValue({ record: record(base.id, 'Device B'), revision: '2' });
    await fixture.sync.synchronize();
    expect(fixture.recovered).toHaveBeenCalledWith({ name: 'Device A conflict copy', deletion: false });
    expect((await fixture.cache.load(base.id))?.name).toBe('Device B');
    expect(fixture.client.commit.mock.calls).toHaveLength(2);
    expect(fixture.client.commit.mock.calls[1]![0]).toMatchObject({ expectedRevision: null });
    expect(fixture.client.commit.mock.calls[1]![0].boardId).not.toBe(base.id);
    expect(await fixture.cache.pending()).toEqual([]);
  });

  it('respects remote deletion rather than recreating the old ID', async () => {
    const fixture = setup();
    const base = record();
    await fixture.cache.cacheRemote(base, '1');
    await fixture.cache.save(record(base.id, 'Offline work'), 1);
    fixture.client.commit.mockRejectedValueOnce(new CloudRequestError(410, 'BOARD_DELETED')).mockResolvedValueOnce('1');
    fixture.client.list.mockResolvedValue([{ id: base.id, name: 'Deleted', revision: '2', updatedAt: 1, deletedAt: 1 }]);
    await fixture.sync.synchronize();
    expect(await fixture.cache.load(base.id)).toBeNull();
    expect((await fixture.cache.list())[0]?.name).toBe('Offline work conflict copy');
    expect(fixture.changed).toHaveBeenCalledWith(expect.objectContaining({ id: base.id, deleted: true }));
    expect(await fixture.cache.pending()).toEqual([]);
  });

  it('preserves the original queue if a missing remote board has no authoritative tombstone', async () => {
    const fixture = setup();
    const base = record();
    await fixture.cache.cacheRemote(base, '1');
    await fixture.cache.save(record(base.id, 'Offline work'), 1);
    fixture.client.commit.mockRejectedValue(new CloudRequestError(404, 'NOT_FOUND'));
    await fixture.sync.synchronize();
    expect(fixture.states.at(-1)).toBe('error');
    expect(await fixture.cache.pending()).toHaveLength(1);
    expect((await fixture.cache.load(base.id))?.name).toBe('Offline work');
  });

  it('retains a recoverable copy when server policy rejects its files after a role change', async () => {
    const fixture = setup();
    const base = record();
    await fixture.cache.cacheRemote(base, '1');
    await fixture.cache.save(record(base.id, 'Local work'), 1);
    fixture.client.commit.mockRejectedValueOnce(new CloudRequestError(409, 'REVISION_CONFLICT'))
      .mockRejectedValueOnce(new CloudRequestError(422, 'ATTACHMENT_SIZE'));
    fixture.client.load.mockResolvedValue({ record: record(base.id, 'Remote work'), revision: '2' });
    await fixture.sync.synchronize();
    expect(fixture.states.at(-1)).toBe('policy-error');
    expect((await fixture.cache.list()).map((board) => board.name).sort()).toEqual(['Local work conflict copy', 'Remote work']);
    expect(await fixture.cache.pending()).toHaveLength(1);
  });

  it('does not label malformed acknowledgements successful', async () => {
    const fixture = setup();
    await fixture.cache.save(record(), null);
    fixture.client.commit.mockRejectedValue(new CloudProtocolError('Invalid acknowledgement'));
    await fixture.sync.synchronize();
    expect(fixture.states.at(-1)).toBe('error');
    expect(await fixture.cache.pending()).toHaveLength(1);
  });
});
