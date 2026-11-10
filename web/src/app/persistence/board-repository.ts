import { InjectionToken } from '@angular/core';
import { AttachmentMeta, BoardSummary } from '../core/model';

/** Raw persisted record; validated and migrated by the caller. */
export interface BoardRecord {
  id: string;
  name: string;
  schemaVersion: number;
  revision: number;
  updatedAt: number;
  doc: unknown;
  camera: unknown;
}

export class RevisionConflictError extends Error {
  constructor(readonly storedRevision: number) {
    super(`Board was changed elsewhere (revision ${storedRevision})`);
  }
}

/**
 * Storage contract for boards and attachments. On-device today; a remote API
 * implementation can replace it without touching editor code.
 */
export interface BoardRepository {
  list(): Promise<BoardSummary[]>;
  load(id: string): Promise<BoardRecord | null>;
  /** Saves with optimistic concurrency; returns the new revision. */
  save(record: Omit<BoardRecord, 'revision'>, expectedRevision: number | null): Promise<{ revision: number }>;
  delete(id: string): Promise<void>;
  putAttachment(boardId: string, meta: AttachmentMeta, blob: Blob): Promise<void>;
  getAttachment(boardId: string, attachmentId: string): Promise<Blob | null>;
  deleteAttachment(boardId: string, attachmentId: string): Promise<void>;
  listAttachmentIds(boardId: string): Promise<string[]>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
}

export const BOARD_REPOSITORY = new InjectionToken<BoardRepository>('BOARD_REPOSITORY');

export class MemoryBoardRepository implements BoardRepository {
  private boards = new Map<string, BoardRecord>();
  private attachments = new Map<string, Blob>();
  private meta = new Map<string, unknown>();

  async list(): Promise<BoardSummary[]> {
    return [...this.boards.values()]
      .map((b) => ({ id: b.id, name: b.name, updatedAt: b.updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(id: string): Promise<BoardRecord | null> {
    const b = this.boards.get(id);
    return b ? JSON.parse(JSON.stringify(b)) : null;
  }

  async save(record: Omit<BoardRecord, 'revision'>, expectedRevision: number | null) {
    const current = this.boards.get(record.id);
    if (current && expectedRevision !== null && current.revision > expectedRevision) {
      throw new RevisionConflictError(current.revision);
    }
    const revision = (current?.revision ?? 0) + 1;
    this.boards.set(record.id, JSON.parse(JSON.stringify({ ...record, revision })));
    return { revision };
  }

  async delete(id: string): Promise<void> {
    this.boards.delete(id);
    for (const key of [...this.attachments.keys()]) if (key.startsWith(id + '/')) this.attachments.delete(key);
  }

  async putAttachment(boardId: string, meta: AttachmentMeta, blob: Blob): Promise<void> {
    this.attachments.set(`${boardId}/${meta.id}`, blob);
  }

  async getAttachment(boardId: string, attachmentId: string): Promise<Blob | null> {
    return this.attachments.get(`${boardId}/${attachmentId}`) ?? null;
  }

  async deleteAttachment(boardId: string, attachmentId: string): Promise<void> {
    this.attachments.delete(`${boardId}/${attachmentId}`);
  }

  async listAttachmentIds(boardId: string): Promise<string[]> {
    return [...this.attachments.keys()].filter((k) => k.startsWith(boardId + '/')).map((k) => k.slice(boardId.length + 1));
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return this.meta.get(key) as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    this.meta.set(key, value);
  }
}
