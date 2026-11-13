import { InjectionToken } from '@angular/core';
import { AttachmentMeta, BoardSummary } from '../core/model';
import { AttachmentRole, attachmentPolicyViolation } from '../../../../shared/attachment-policy';

export type WorkspaceIdentity = { kind: 'guest' } | { kind: 'account'; accountId: string };

export interface BoardSaveResult {
  revision: number;
  localDurability: 'persistent' | 'memory';
  cloud: { status: 'not-applicable' | 'pending' } | { status: 'acknowledged'; revision: string };
}

export interface AttachmentWriteContext {
  nodeId: string;
  attachments: readonly AttachmentMeta[];
}

export class AttachmentPolicyError extends Error {
  constructor(readonly violation: 'size' | 'count' | 'metadata') {
    super(`Attachment rejected: ${violation}`);
  }
}

export function assertAttachmentWrite(
  role: AttachmentRole, meta: AttachmentMeta, blob: Pick<Blob, 'size'>, context: AttachmentWriteContext,
): void {
  if (!context.nodeId || !Number.isSafeInteger(meta.size) || meta.size < 0 || blob.size !== meta.size) {
    throw new AttachmentPolicyError('metadata');
  }
  const violation = attachmentPolicyViolation(role, [...context.attachments.filter((a) => a.id !== meta.id).map((a) => a.size), blob.size]);
  if (violation) throw new AttachmentPolicyError(violation);
}

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
 * Storage contract shared by guest storage and account-scoped offline caches.
 */
export interface BoardRepository {
  readonly localDurability: BoardSaveResult['localDurability'];
  readonly workspace: WorkspaceIdentity;
  readonly attachmentRole: AttachmentRole;
  list(): Promise<BoardSummary[]>;
  load(id: string): Promise<BoardRecord | null>;
  /** Local durability and cloud acknowledgement are independent. */
  save(record: Omit<BoardRecord, 'revision'>, expectedRevision: number | null): Promise<BoardSaveResult>;
  delete(id: string): Promise<void>;
  putAttachment(boardId: string, meta: AttachmentMeta, blob: Blob, context: AttachmentWriteContext): Promise<void>;
  copyAttachment?(
    sourceBoardId: string, sourceId: string, boardId: string, meta: AttachmentMeta, context: AttachmentWriteContext,
  ): Promise<void>;
  getAttachment(boardId: string, attachmentId: string): Promise<Blob | null>;
  deleteAttachment(boardId: string, attachmentId: string): Promise<void>;
  listAttachmentIds(boardId: string): Promise<string[]>;
  /** Optional account-cache cleanup that also respects queued snapshots. */
  collectUnreferencedAttachments?(boardId: string): Promise<void>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
}

export const BOARD_REPOSITORY = new InjectionToken<BoardRepository>('BOARD_REPOSITORY');

export class MemoryBoardRepository implements BoardRepository {
  readonly localDurability: BoardSaveResult['localDurability'] = 'memory';
  readonly workspace: WorkspaceIdentity = { kind: 'guest' };
  readonly attachmentRole: AttachmentRole = 'guest';
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

  async save(record: Omit<BoardRecord, 'revision'>, expectedRevision: number | null): Promise<BoardSaveResult> {
    const current = this.boards.get(record.id);
    if (current ? expectedRevision !== current.revision : expectedRevision !== null) {
      throw new RevisionConflictError(current?.revision ?? 0);
    }
    const revision = (current?.revision ?? 0) + 1;
    this.boards.set(record.id, JSON.parse(JSON.stringify({ ...record, revision })));
    return { revision, localDurability: 'memory', cloud: { status: 'not-applicable' } };
  }

  async delete(id: string): Promise<void> {
    this.boards.delete(id);
    for (const key of [...this.attachments.keys()]) if (key.startsWith(id + '/')) this.attachments.delete(key);
  }

  async putAttachment(boardId: string, meta: AttachmentMeta, blob: Blob, context: AttachmentWriteContext): Promise<void> {
    assertAttachmentWrite(this.attachmentRole, meta, blob, context);
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
