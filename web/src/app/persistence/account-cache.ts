import { DBSchema, IDBPDatabase, openDB } from 'idb';
import { AttachmentRole } from '../../../../shared/attachment-policy';
import { AttachmentMeta, BoardSummary, SCHEMA_VERSION } from '../core/model';
import { NewerSchemaError } from './migrations';
import { migrateBoard } from './migrations';
import { canonicalJson } from '../../../../shared/canonical-json';
import type { RemoteBoard } from './cloud-board-client';
import {
  AttachmentWriteContext, BoardRecord, BoardRepository, BoardSaveResult, RevisionConflictError,
  WorkspaceIdentity, assertAttachmentWrite,
} from './board-repository';

export const ACCOUNT_CHUNK_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CachedBoard extends BoardRecord {
  serverRevision: string | null;
  acknowledgedSequence: number;
  deleted: boolean;
  base: Omit<BoardRecord, 'revision'> | null;
}

export interface PendingMutation {
  id: number;
  mutationId: string;
  boardId: string;
  sequence: number;
  kind: 'save' | 'delete';
  state: 'queued' | 'sending';
  expectedRevision?: string | null;
  record: Omit<BoardRecord, 'revision'> | null;
}

interface CachedAttachment {
  boardId: string;
  id: string;
  nodeId: string;
  meta: AttachmentMeta;
  chunkCount: number;
  complete: boolean;
  serverReady: boolean;
  source?: { boardId: string; id: string };
}

export interface CloudRecoveryNotice {
  name: string | null;
  deletion: boolean;
}

export type RemoteChange = RemoteBoard | { id: string; revision: string; deleted: true };

interface AccountDb extends DBSchema {
  boards: { key: string; value: CachedBoard };
  attachments: { key: [string, string]; value: CachedAttachment; indexes: { byBoard: string } };
  chunks: { key: [string, string, number]; value: { boardId: string; attachmentId: string; index: number; data: ArrayBuffer }; indexes: { byAttachment: [string, string]; byBoard: string } };
  outbox: { key: number; value: PendingMutation; indexes: { byBoard: string } };
  meta: { key: string; value: unknown };
}

export class PendingChangesError extends Error {
  constructor() { super('Local changes must be synchronized or recovered before replacing this board.'); }
}

export class OfflineAttachmentUnavailableError extends Error {
  constructor() { super('This attachment is not available in the offline cache.'); }
}

function serverRevision(value: string): void {
  if (!/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) throw new Error('Invalid server revision');
}

function nextOutboxId(value: unknown): number {
  if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Invalid outbox sequence in account cache');
  }
  const next = (typeof value === 'number' ? value : 0) + 1;
  if (!Number.isSafeInteger(next)) throw new Error('Outbox sequence capacity exceeded');
  return next;
}

async function write<T>(tx: { abort(): void; done: Promise<unknown> }, action: () => Promise<T>): Promise<T> {
  try {
    const result = await action();
    await tx.done;
    return result;
  } catch (error) {
    try { tx.abort(); }
    catch (abortError) {
      if (!(abortError instanceof Error) || abortError.name !== 'InvalidStateError') {
        await tx.done.catch(() => undefined);
        throw new AggregateError([error, abortError], 'Cache transaction and abort failed');
      }
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
}

/** Separate database per account; guest database/version are never opened here. */
export class AccountBoardCache implements BoardRepository {
  readonly localDurability = 'persistent' as const;
  readonly workspace: WorkspaceIdentity;
  readonly attachmentRole: AttachmentRole;
  private dbPromise: Promise<IDBPDatabase<AccountDb>> | undefined;
  private readonly pendingListeners = new Set<() => void>();

  onPendingChange(listener: () => void): () => void {
    this.pendingListeners.add(listener);
    return () => this.pendingListeners.delete(listener);
  }

  private changed(): void { for (const listener of this.pendingListeners) listener(); }

  constructor(readonly accountId: string, role: 'basic' | 'admin') {
    if (!UUID.test(accountId) || !['basic', 'admin'].includes(role)) throw new Error('Invalid account cache identity or role');
    this.workspace = { kind: 'account', accountId: accountId.toLowerCase() };
    this.attachmentRole = role;
  }

  private db(): Promise<IDBPDatabase<AccountDb>> {
    this.dbPromise ??= openDB<AccountDb>(`better-mindmap-account-${this.accountId.toLowerCase()}`, 1, {
      upgrade(db) {
        db.createObjectStore('boards', { keyPath: 'id' });
        db.createObjectStore('attachments', { keyPath: ['boardId', 'id'] }).createIndex('byBoard', 'boardId');
        const chunks = db.createObjectStore('chunks', { keyPath: ['boardId', 'attachmentId', 'index'] });
        chunks.createIndex('byAttachment', ['boardId', 'attachmentId']);
        chunks.createIndex('byBoard', 'boardId');
        db.createObjectStore('outbox', { keyPath: 'id' }).createIndex('byBoard', 'boardId');
        db.createObjectStore('meta');
      },
      // Another tab discarding this account's cache must not be blocked by an idle connection.
      blocking: () => { void this.dbPromise?.then((db) => db.close()); },
    });
    return this.dbPromise;
  }

  async close(): Promise<void> { (await this.dbPromise)?.close(); }

  /** Boards/files/changes of an account that exist only on this device (never includes cloud data). */
  static async summarize(accountId: string): Promise<{ pending: number; boards: number }> {
    const cache = new AccountBoardCache(accountId, 'basic');
    try { return { pending: (await cache.pending(10_000)).length, boards: (await cache.list()).length }; }
    finally { await cache.close(); }
  }

  /** Deletes the whole private IndexedDB for one account; unsynchronized work in it is lost. */
  static async discard(accountId: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(`better-mindmap-account-${accountId.toLowerCase()}`);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('Account cache could not be deleted'));
      request.onblocked = () => reject(new Error('The account cache is still open in another tab'));
    });
  }

  async list(): Promise<BoardSummary[]> {
    return (await (await this.db()).getAll('boards')).filter((b) => !b.deleted)
      .map((b) => ({ id: b.id, name: b.name, updatedAt: b.updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(id: string): Promise<CachedBoard | null> {
    const board = await (await this.db()).get('boards', id);
    return board && !board.deleted ? board : null;
  }

  async syncBoard(id: string): Promise<CachedBoard | undefined> {
    return (await this.db()).get('boards', id);
  }

  async save(record: Omit<BoardRecord, 'revision'>, expectedRevision: number | null): Promise<BoardSaveResult> {
    if (!UUID.test(record.id)) throw new Error('Cloud board identities must be UUIDs');
    const tx = (await this.db()).transaction(['boards', 'outbox', 'meta'], 'readwrite');
    const result = await write(tx, async (): Promise<BoardSaveResult> => {
      const current = await tx.objectStore('boards').get(record.id);
      if (current && current.schemaVersion > SCHEMA_VERSION) throw new NewerSchemaError(current.schemaVersion);
      if (record.schemaVersion > SCHEMA_VERSION) throw new NewerSchemaError(record.schemaVersion);
      if (current && (current.deleted || expectedRevision === null || current.revision !== expectedRevision)) {
        throw new RevisionConflictError(current.revision);
      }
      if (!current && expectedRevision !== null) throw new RevisionConflictError(0);
      const revision = (current?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new Error('Local revision capacity exceeded');
      const id = nextOutboxId(await tx.objectStore('meta').get('outboxSequence'));
      const previous = await tx.objectStore('outbox').index('byBoard').getAll(record.id);
      for (const operation of previous) {
        if (operation.state === 'queued' && operation.kind === 'save') await tx.objectStore('outbox').delete(operation.id);
      }
      await tx.objectStore('boards').put({
        ...record, revision, serverRevision: current?.serverRevision ?? null,
        acknowledgedSequence: current?.acknowledgedSequence ?? 0, deleted: false, base: current?.base ?? null,
      });
      await tx.objectStore('outbox').put({
        id, mutationId: crypto.randomUUID(), boardId: record.id, sequence: revision,
        kind: 'save', state: 'queued', record,
      });
      await tx.objectStore('meta').put(id, 'outboxSequence');
      return { revision, localDurability: 'persistent', cloud: { status: 'pending' } };
    });
    this.changed();
    return result;
  }

  async delete(id: string): Promise<void> {
    const tx = (await this.db()).transaction(['boards', 'outbox', 'meta', 'attachments', 'chunks'], 'readwrite');
    await write(tx, async () => {
      const board = await tx.objectStore('boards').get(id);
      if (!board || board.deleted) return;
      const queued = await tx.objectStore('outbox').index('byBoard').getAll(id);
      const revision = board.revision + 1;
      if (!Number.isSafeInteger(revision)) throw new Error('Local revision capacity exceeded');
      if (board.serverRevision === null && queued.every((op) => op.state === 'queued')) {
        for (const op of queued) await tx.objectStore('outbox').delete(op.id);
        for (const key of await tx.objectStore('attachments').index('byBoard').getAllKeys(id)) {
          await tx.objectStore('attachments').delete(key);
        }
        for (const key of await tx.objectStore('chunks').index('byBoard').getAllKeys(id)) await tx.objectStore('chunks').delete(key);
        await tx.objectStore('boards').put({ ...board, deleted: true, revision, acknowledgedSequence: revision });
        return;
      }
      const next = nextOutboxId(await tx.objectStore('meta').get('outboxSequence'));
      await tx.objectStore('boards').put({ ...board, deleted: true, revision });
      await tx.objectStore('outbox').put({
        id: next, mutationId: crypto.randomUUID(), boardId: id, sequence: revision,
        kind: 'delete', state: 'queued', record: null,
      });
      await tx.objectStore('meta').put(next, 'outboxSequence');
    });
    this.changed();
  }

  /** Frees file bytes no longer referenced by the board, its queued snapshots or its last server snapshot. */
  async collectUnreferencedAttachments(boardId: string): Promise<void> {
    const tx = (await this.db()).transaction(['boards', 'outbox', 'attachments', 'chunks'], 'readwrite');
    await write(tx, async () => {
      const board = await tx.objectStore('boards').get(boardId);
      if (!board || board.deleted) return;
      const used = new Set<string>();
      const collect = (record: object | null | undefined) => {
        if (!record) return;
        for (const node of Object.values(migrateBoard(record).doc.nodes)) {
          for (const meta of node.attachments ?? []) used.add(meta.id);
        }
      };
      collect(board);
      collect(board.base);
      for (const operation of await tx.objectStore('outbox').index('byBoard').getAll(boardId)) collect(operation.record);
      for (const attachment of await tx.objectStore('attachments').index('byBoard').getAll(boardId)) {
        if (used.has(attachment.id) || !attachment.complete) continue;
        for (const key of await tx.objectStore('chunks').index('byAttachment').getAllKeys([boardId, attachment.id])) {
          await tx.objectStore('chunks').delete(key);
        }
        await tx.objectStore('attachments').delete([boardId, attachment.id]);
      }
    });
  }

  async pending(limit = 20): Promise<PendingMutation[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('A positive outbox batch size is required');
    return (await this.db()).getAll('outbox', undefined, limit);
  }

  async hasPending(boardId: string): Promise<boolean> {
    return (await (await this.db()).countFromIndex('outbox', 'byBoard', boardId)) > 0;
  }

  async beginMutation(id: number): Promise<PendingMutation> {
    const tx = (await this.db()).transaction(['boards', 'outbox'], 'readwrite');
    return write(tx, async () => {
      const operation = await tx.objectStore('outbox').get(id);
      if (!operation) throw new PendingChangesError();
      if (operation.state === 'sending') return operation;
      const board = await tx.objectStore('boards').get(operation.boardId);
      if (!board) throw new Error('Pending mutation has no board');
      const earlier = await tx.objectStore('outbox').index('byBoard').getAll(operation.boardId);
      if (earlier.some((op) => op.id < id)) throw new Error('Earlier board mutations must synchronize first');
      operation.state = 'sending';
      operation.expectedRevision = board.serverRevision;
      await tx.objectStore('outbox').put(operation);
      return operation;
    });
  }

  async acknowledge(id: number, revision: string): Promise<void> {
    serverRevision(revision);
    const tx = (await this.db()).transaction(['boards', 'outbox', 'attachments', 'chunks'], 'readwrite');
    await write(tx, async () => {
      const operation = await tx.objectStore('outbox').get(id);
      if (!operation || operation.state !== 'sending') throw new Error('Acknowledged mutation was not in flight');
      const board = await tx.objectStore('boards').get(operation.boardId);
      if (!board) throw new Error('Acknowledged mutation has no cached board');
      if ((board.serverRevision && BigInt(revision) < BigInt(board.serverRevision)) ||
          operation.sequence <= board.acknowledgedSequence) throw new Error('Acknowledgement is stale');
      await tx.objectStore('boards').put({
        ...board, serverRevision: revision, acknowledgedSequence: operation.sequence,
        base: operation.kind === 'save' ? operation.record : null,
      });
      await tx.objectStore('outbox').delete(id);
      if (operation.kind === 'delete') {
        for (const key of await tx.objectStore('attachments').index('byBoard').getAllKeys(operation.boardId)) {
          await tx.objectStore('attachments').delete(key);
        }
        for (const key of await tx.objectStore('chunks').index('byBoard').getAllKeys(operation.boardId)) {
          await tx.objectStore('chunks').delete(key);
        }
      }
    });
  }

  async requeueRejectedMutation(id: number): Promise<boolean> {
    const tx = (await this.db()).transaction(['outbox', 'boards', 'attachments', 'chunks'], 'readwrite');
    return write(tx, async () => {
      const outbox = tx.objectStore('outbox');
      const operation = await outbox.get(id);
      if (!operation || operation.state !== 'sending') throw new PendingChangesError();
      const board = await tx.objectStore('boards').get(operation.boardId);
      if (!board) throw new Error('Rejected mutation has no board');
      const later = await outbox.index('byBoard').getAll(operation.boardId);
      if (board.deleted && board.serverRevision === null) {
        for (const op of later) await outbox.delete(op.id);
        for (const key of await tx.objectStore('attachments').index('byBoard').getAllKeys(board.id)) {
          await tx.objectStore('attachments').delete(key);
        }
        for (const key of await tx.objectStore('chunks').index('byBoard').getAllKeys(board.id)) await tx.objectStore('chunks').delete(key);
        await tx.objectStore('boards').put({ ...board, acknowledgedSequence: board.revision });
        return true;
      }
      if (operation.kind === 'save' && later.some((op) => op.id > id && op.state === 'queued')) {
        await outbox.delete(id);
        return true;
      } else {
        const { expectedRevision: _expected, ...queued } = operation;
        await outbox.put({ ...queued, state: 'queued' });
        return false;
      }
    });
  }

  async cacheRemote(record: Omit<BoardRecord, 'revision'>, revision: string): Promise<void> {
    serverRevision(revision);
    const tx = (await this.db()).transaction(['boards', 'outbox'], 'readwrite');
    await write(tx, async () => {
      if ((await tx.objectStore('outbox').index('byBoard').getAllKeys(record.id)).length) throw new PendingChangesError();
      const current = await tx.objectStore('boards').get(record.id);
      if (current?.deleted) throw new PendingChangesError();
      if (current?.serverRevision && BigInt(revision) < BigInt(current.serverRevision)) throw new Error('Remote snapshot is stale');
      if (current?.serverRevision === revision) return;
      const localRevision = (current?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(localRevision)) throw new Error('Local revision capacity exceeded');
      await tx.objectStore('boards').put({
        ...record, revision: localRevision, acknowledgedSequence: localRevision,
        serverRevision: revision, deleted: false, base: record,
      });
    });
  }

  async reconcileRemote(
    remote: RemoteChange, expectedLocalRevision: number | null, conflict: boolean, copyName: (name: string) => string,
  ): Promise<{ id: string; revision: number; deleted: boolean; notice?: CloudRecoveryNotice }> {
    serverRevision(remote.revision);
    const id = 'record' in remote ? remote.record.id : remote.id;
    const tx = (await this.db()).transaction(['boards', 'outbox', 'meta', 'attachments', 'chunks'], 'readwrite');
    return write(tx, async () => {
      const current = await tx.objectStore('boards').get(id);
      if ((current?.revision ?? null) !== expectedLocalRevision) throw new PendingChangesError();
      if (current && current.schemaVersion > SCHEMA_VERSION) throw new NewerSchemaError(current.schemaVersion);
      if (current?.serverRevision && BigInt(current.serverRevision) > BigInt(remote.revision)) throw new PendingChangesError();
      const pending = await tx.objectStore('outbox').index('byBoard').getAll(id);
      if (pending.length && !conflict) throw new PendingChangesError();
      const deleted = !('record' in remote);
      if (current?.deleted && !pending.length && !deleted) throw new PendingChangesError();
      const revision = (current?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new Error('Local revision capacity exceeded');
      const remoteRecord = 'record' in remote ? remote.record : {
        id, name: current?.name ?? 'Deleted board', schemaVersion: SCHEMA_VERSION,
        doc: current?.doc ?? null, camera: current?.camera ?? null, updatedAt: Date.now(),
      };
      let notice: CloudRecoveryNotice | undefined;
      let rebased: Omit<BoardRecord, 'revision'> | undefined;
      if (current && pending.length && !(current.deleted && deleted)) {
        const cameraOnly = !current.deleted && current.base && !deleted &&
          canonicalJson(current.doc) === canonicalJson(current.base.doc);
        if (cameraOnly) rebased = { ...remoteRecord, camera: current.camera, updatedAt: Date.now() };
        else {
          const mine = migrateBoard(current);
          const copyId = crypto.randomUUID();
          const name = copyName(mine.doc.name).slice(0, 200);
          const doc = structuredClone(mine.doc);
          doc.id = copyId;
          doc.name = name;
          for (const node of Object.values(doc.nodes)) {
            for (const meta of node.attachments ?? []) {
              const oldId = meta.id;
              meta.id = crypto.randomUUID();
              const attachment = await tx.objectStore('attachments').get([id, oldId]);
              const chunkCount = attachment?.chunkCount ?? Math.ceil(meta.size / ACCOUNT_CHUNK_BYTES);
              if (attachment?.complete) {
                for (let index = 0; index < chunkCount; index++) {
                  const chunk = await tx.objectStore('chunks').get([id, oldId, index]);
                  if (!chunk) throw new OfflineAttachmentUnavailableError();
                  await tx.objectStore('chunks').add({ boardId: copyId, attachmentId: meta.id, index, data: chunk.data });
                }
              }
              await tx.objectStore('attachments').add({
                boardId: copyId, id: meta.id, nodeId: node.id, meta, chunkCount,
                complete: attachment?.complete === true, serverReady: false,
                source: attachment?.source ?? { boardId: id, id: oldId },
              });
            }
          }
          const record = { id: copyId, name, schemaVersion: mine.schemaVersion, doc, camera: mine.camera, updatedAt: Date.now() };
          await tx.objectStore('boards').add({
            ...record, revision: 1, acknowledgedSequence: 0, serverRevision: null, base: null, deleted: false,
          });
          const next = nextOutboxId(await tx.objectStore('meta').get('outboxSequence'));
          await tx.objectStore('outbox').add({
            id: next, boardId: copyId, sequence: 1, mutationId: crypto.randomUUID(), kind: 'save', state: 'queued', record,
          });
          await tx.objectStore('meta').put(next, 'outboxSequence');
          notice = { name, deletion: current.deleted };
          await tx.objectStore('meta').put(notice, 'syncNotice');
        }
      }
      for (const op of pending) await tx.objectStore('outbox').delete(op.id);
      await tx.objectStore('boards').put({
        ...(rebased ?? remoteRecord), revision, acknowledgedSequence: rebased ? revision - 1 : revision,
        serverRevision: remote.revision, base: deleted ? null : remoteRecord, deleted,
      });
      if (rebased) {
        const next = nextOutboxId(await tx.objectStore('meta').get('outboxSequence'));
        await tx.objectStore('outbox').add({
          id: next, boardId: id, sequence: revision, mutationId: crypto.randomUUID(), kind: 'save', state: 'queued', record: rebased,
        });
        await tx.objectStore('meta').put(next, 'outboxSequence');
      }
      return { id, revision, deleted, ...(notice ? { notice } : {}) };
    });
  }

  async putAttachment(boardId: string, meta: AttachmentMeta, blob: Blob, context: AttachmentWriteContext): Promise<void> {
    assertAttachmentWrite(this.attachmentRole, meta, blob, context);
    const db = await this.db();
    const existing = await db.get('attachments', [boardId, meta.id]);
    if (existing) throw new Error('Attachment identities are immutable; use a new identity for new bytes');
    const chunkCount = Math.ceil(blob.size / ACCOUNT_CHUNK_BYTES);
    await db.add('attachments', { boardId, id: meta.id, meta, nodeId: context.nodeId, chunkCount, complete: false, serverReady: false });
    try {
      for (let index = 0; index < chunkCount; index++) {
        const data = await blob.slice(index * ACCOUNT_CHUNK_BYTES, (index + 1) * ACCOUNT_CHUNK_BYTES).arrayBuffer();
        await db.put('chunks', { boardId, attachmentId: meta.id, index, data });
      }
      await db.put('attachments', { boardId, id: meta.id, meta, nodeId: context.nodeId, chunkCount, complete: true, serverReady: false });
    } catch (error) {
      try { await this.deleteAttachment(boardId, meta.id); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Attachment cache write and cleanup failed'); }
      throw error;
    }
  }

  async *readAttachmentChunks(boardId: string, attachmentId: string): AsyncGenerator<Uint8Array<ArrayBuffer>> {
    const db = await this.db();
    const attachment = await db.get('attachments', [boardId, attachmentId]);
    if (!attachment?.complete) throw new OfflineAttachmentUnavailableError();
    let size = 0;
    for (let index = 0; index < attachment.chunkCount; index++) {
      const chunk = await db.get('chunks', [boardId, attachmentId, index]);
      if (!chunk) throw new OfflineAttachmentUnavailableError();
      size += chunk.data.byteLength;
      yield new Uint8Array(chunk.data);
    }
    if (size !== attachment.meta.size) throw new Error('Cached attachment bytes do not match their metadata');
  }

  async getAttachment(boardId: string, attachmentId: string): Promise<Blob | null> {
    const attachment = await (await this.db()).get('attachments', [boardId, attachmentId]);
    if (!attachment) return null;
    let blob = new Blob([], { type: attachment.meta.mime });
    for await (const chunk of this.readAttachmentChunks(boardId, attachmentId)) {
      blob = new Blob([blob, chunk], { type: attachment.meta.mime });
    }
    return blob;
  }

  async deleteAttachment(boardId: string, attachmentId: string): Promise<void> {
    const tx = (await this.db()).transaction(['attachments', 'chunks'], 'readwrite');
    await write(tx, async () => {
      const keys = await tx.objectStore('chunks').index('byAttachment').getAllKeys([boardId, attachmentId]);
      for (const key of keys) await tx.objectStore('chunks').delete(key);
      await tx.objectStore('attachments').delete([boardId, attachmentId]);
    });
  }

  async listAttachmentIds(boardId: string): Promise<string[]> {
    return (await (await this.db()).getAllFromIndex('attachments', 'byBoard', boardId)).filter((a) => a.complete).map((a) => a.id);
  }

  async attachmentReady(boardId: string, id: string): Promise<boolean> {
    return (await (await this.db()).get('attachments', [boardId, id]))?.serverReady === true;
  }

  /** Locally complete files not yet confirmed on the server. */
  async pendingAttachmentIds(boardId: string): Promise<string[]> {
    return (await (await this.db()).getAllFromIndex('attachments', 'byBoard', boardId))
      .filter((attachment) => attachment.complete && !attachment.serverReady).map((attachment) => attachment.id);
  }

  async attachmentSource(boardId: string, id: string): Promise<{ boardId: string; id: string } | null> {
    const attachment = await (await this.db()).get('attachments', [boardId, id]);
    return attachment?.complete ? null : attachment?.source ?? null;
  }

  async receiveAttachment(
    boardId: string, meta: AttachmentMeta, nodeId: string, stream: ReadableStream<Uint8Array<ArrayBuffer>>, signal: AbortSignal,
    options: { serverReady?: boolean } = {},
  ): Promise<void> {
    const reader = stream.getReader();
    try {
      const db = await this.db();
      const existing = await db.get('attachments', [boardId, meta.id]);
      if (existing?.complete) { await reader.cancel(); return; }
      const chunkCount = Math.ceil(meta.size / ACCOUNT_CHUNK_BYTES);
      const attachment: CachedAttachment = {
        ...existing, boardId, id: meta.id, meta, nodeId, chunkCount, complete: false, serverReady: options.serverReady === true,
      };
      await db.put('attachments', attachment);
      let size = 0;
      let index = 0;
      let buffer = new Uint8Array(ACCOUNT_CHUNK_BYTES);
      let used = 0;
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > meta.size) throw new Error('Downloaded attachment exceeds its declared size');
        for (let offset = 0; offset < value.byteLength;) {
          const count = Math.min(buffer.length - used, value.byteLength - offset);
          buffer.set(value.subarray(offset, offset + count), used);
          used += count;
          offset += count;
          if (used === buffer.length) {
            await db.put('chunks', { boardId, attachmentId: meta.id, index: index++, data: buffer.buffer });
            buffer = new Uint8Array(ACCOUNT_CHUNK_BYTES);
            used = 0;
          }
        }
      }
      if (size !== meta.size) throw new Error('Downloaded attachment is incomplete');
      if (used) await db.put('chunks', { boardId, attachmentId: meta.id, index, data: buffer.slice(0, used).buffer });
      signal.throwIfAborted();
      await db.put('attachments', { ...attachment, complete: true });
    } catch (error) {
      try { await reader.cancel(error); }
      catch (cancelError) { throw new AggregateError([error, cancelError], 'Attachment download and cancellation failed'); }
      throw error;
    } finally { reader.releaseLock(); }
  }

  async markAttachmentReady(boardId: string, id: string): Promise<void> {
    const tx = (await this.db()).transaction('attachments', 'readwrite');
    await write(tx, async () => {
      const attachment = await tx.store.get([boardId, id]);
      if (!attachment?.complete) throw new OfflineAttachmentUnavailableError();
      await tx.store.put({ ...attachment, serverReady: true });
    });
  }

  async attachmentPart(boardId: string, id: string, offset: number, length: number): Promise<Blob> {
    const db = await this.db();
    const attachment = await db.get('attachments', [boardId, id]);
    if (!attachment?.complete) throw new OfflineAttachmentUnavailableError();
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
        offset < 0 || length < 0 || offset + length > attachment.meta.size) throw new Error('Invalid attachment range');
    const chunks: BlobPart[] = [];
    for (let index = Math.floor(offset / ACCOUNT_CHUNK_BYTES); index < Math.ceil((offset + length) / ACCOUNT_CHUNK_BYTES); index++) {
      const chunk = await db.get('chunks', [boardId, id, index]);
      if (!chunk) throw new OfflineAttachmentUnavailableError();
      const start = index * ACCOUNT_CHUNK_BYTES;
      chunks.push(chunk.data.slice(Math.max(0, offset - start), Math.min(chunk.data.byteLength, offset + length - start)));
    }
    const part = new Blob(chunks, { type: 'application/octet-stream' });
    if (part.size !== length) throw new OfflineAttachmentUnavailableError();
    return part;
  }

  async copyAttachment(
    sourceBoardId: string, sourceId: string, boardId: string, meta: AttachmentMeta, context: AttachmentWriteContext,
  ): Promise<void> {
    const tx = (await this.db()).transaction(['attachments', 'chunks'], 'readwrite');
    await write(tx, async () => {
      const source = await tx.objectStore('attachments').get([sourceBoardId, sourceId]);
      if (!source?.complete) throw new OfflineAttachmentUnavailableError();
      assertAttachmentWrite(this.attachmentRole, meta, { size: source.meta.size }, context);
      if (await tx.objectStore('attachments').get([boardId, meta.id])) throw new Error('Attachment identity already exists');
      for (let index = 0; index < source.chunkCount; index++) {
        const chunk = await tx.objectStore('chunks').get([sourceBoardId, sourceId, index]);
        if (!chunk) throw new OfflineAttachmentUnavailableError();
        await tx.objectStore('chunks').add({ boardId, attachmentId: meta.id, index, data: chunk.data });
      }
      await tx.objectStore('attachments').add({
        ...source, boardId, id: meta.id, meta, nodeId: context.nodeId, serverReady: false,
      });
    });
  }

  async syncLease(owner: string, now: number, lifetime: number): Promise<boolean> {
    const tx = (await this.db()).transaction('meta', 'readwrite');
    return write(tx, async () => {
      const value = await tx.store.get('syncLease');
      if (value !== undefined) {
        if (!value || typeof value !== 'object' ||
            !('owner' in value) || typeof value.owner !== 'string' ||
            !('expires' in value) || typeof value.expires !== 'number' || !Number.isFinite(value.expires)) {
          throw new Error('Invalid account sync lease');
        }
        if (value.owner !== owner && value.expires > now) return false;
      }
      await tx.store.put({ owner, expires: now + lifetime }, 'syncLease');
      return true;
    });
  }

  async releaseSyncLease(owner: string): Promise<void> {
    const tx = (await this.db()).transaction('meta', 'readwrite');
    await write(tx, async () => {
      const lease = await tx.store.get('syncLease');
      if (lease && typeof lease === 'object' && 'owner' in lease && lease.owner === owner) await tx.store.delete('syncLease');
    });
  }

  async getMeta<T>(key: string): Promise<T | undefined> { return (await (await this.db()).get('meta', key)) as T | undefined; }
  async setMeta(key: string, value: unknown): Promise<void> { await (await this.db()).put('meta', value, key); }
}
