import { DBSchema, IDBPDatabase, openDB } from 'idb';
import { AttachmentMeta, BoardSummary } from '../core/model';
import {
  AttachmentWriteContext, BoardRecord, BoardRepository, BoardSaveResult, RevisionConflictError,
  WorkspaceIdentity, assertAttachmentWrite,
} from './board-repository';
import { AttachmentRole } from '../../../../shared/attachment-policy';

interface AttachmentRecord {
  boardId: string;
  id: string;
  meta: AttachmentMeta;
  /** Raw bytes: Blobs in IndexedDB are unreliable in some WebKit builds. */
  data: ArrayBuffer;
}

interface MindmapDb extends DBSchema {
  boards: { key: string; value: BoardRecord };
  attachments: { key: [string, string]; value: AttachmentRecord; indexes: { byBoard: string } };
  meta: { key: string; value: unknown };
}

export const DB_NAME = 'better-mindmap';

export class IndexedDbBoardRepository implements BoardRepository {
  readonly localDurability = 'persistent' as const;
  readonly workspace: WorkspaceIdentity = { kind: 'guest' };
  readonly attachmentRole: AttachmentRole = 'guest';
  private dbPromise: Promise<IDBPDatabase<MindmapDb>> | null = null;

  constructor(private readonly dbName = DB_NAME) {}

  private db(): Promise<IDBPDatabase<MindmapDb>> {
    this.dbPromise ??= openDB<MindmapDb>(this.dbName, 1, {
      upgrade(db) {
        db.createObjectStore('boards', { keyPath: 'id' });
        const att = db.createObjectStore('attachments', { keyPath: ['boardId', 'id'] });
        att.createIndex('byBoard', 'boardId');
        db.createObjectStore('meta');
      },
    });
    return this.dbPromise;
  }

  async list(): Promise<BoardSummary[]> {
    const all = await (await this.db()).getAll('boards');
    return all
      .map((b) => ({ id: b.id, name: b.name, updatedAt: b.updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(id: string): Promise<BoardRecord | null> {
    return (await (await this.db()).get('boards', id)) ?? null;
  }

  async save(record: Omit<BoardRecord, 'revision'>, expectedRevision: number | null): Promise<BoardSaveResult> {
    const db = await this.db();
    const tx = db.transaction('boards', 'readwrite');
    const current = await tx.store.get(record.id);
    if (current ? expectedRevision !== current.revision : expectedRevision !== null) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new RevisionConflictError(current?.revision ?? 0);
    }
    const revision = (current?.revision ?? 0) + 1;
    await tx.store.put({ ...record, revision });
    await tx.done;
    return { revision, localDurability: 'persistent', cloud: { status: 'not-applicable' } };
  }

  async delete(id: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(['boards', 'attachments'], 'readwrite');
    await tx.objectStore('boards').delete(id);
    const keys = await tx.objectStore('attachments').index('byBoard').getAllKeys(id);
    await Promise.all(keys.map((k) => tx.objectStore('attachments').delete(k)));
    await tx.done;
  }

  async putAttachment(boardId: string, meta: AttachmentMeta, blob: Blob, context: AttachmentWriteContext): Promise<void> {
    assertAttachmentWrite(this.attachmentRole, meta, blob, context);
    const data = await blob.arrayBuffer();
    await (await this.db()).put('attachments', { boardId, id: meta.id, meta, data });
  }

  async getAttachment(boardId: string, attachmentId: string): Promise<Blob | null> {
    const rec = await (await this.db()).get('attachments', [boardId, attachmentId]);
    return rec ? new Blob([rec.data], { type: rec.meta.mime }) : null;
  }

  async deleteAttachment(boardId: string, attachmentId: string): Promise<void> {
    await (await this.db()).delete('attachments', [boardId, attachmentId]);
  }

  async listAttachmentIds(boardId: string): Promise<string[]> {
    const keys = await (await this.db()).getAllKeysFromIndex('attachments', 'byBoard', boardId);
    return keys.map((k) => k[1]);
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await (await this.db()).get('meta', key)) as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await (await this.db()).put('meta', value, key);
  }
}

/** Opens IndexedDB, or falls back to memory when unavailable (private mode, blocked). */
export async function probeIndexedDb(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  try {
    const repo = new IndexedDbBoardRepository();
    await repo.getMeta('probe');
    return true;
  } catch {
    return false;
  }
}
