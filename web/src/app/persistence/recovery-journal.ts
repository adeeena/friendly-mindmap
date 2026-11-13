import { BoardDoc, Camera, SCHEMA_VERSION, createId } from '../core/model';
import { validateBoardDoc, validateCamera } from '../core/validate';
import { BoardRecord, BoardRepository, RevisionConflictError, WorkspaceIdentity } from './board-repository';

type Snapshot = Omit<BoardRecord, 'revision'> & { doc: BoardDoc; camera: Camera };

export interface RecoveryEntry {
  key: string;
  sequence: number;
  recoveryId: string;
  baseRevision: number | null;
  record: Snapshot;
}

const PREFIX = 'better-mindmap-recovery:';

function workspacePrefix(workspace: WorkspaceIdentity): string {
  return PREFIX + (workspace.kind === 'guest' ? 'guest' : `account:${workspace.accountId.toLowerCase()}`) + ':';
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parse(key: string, raw: string): RecoveryEntry {
  const value: unknown = JSON.parse(raw);
  if (!object(value) || value['format'] !== 1 || !revision(value['sequence']) ||
      typeof value['recoveryId'] !== 'string' || !value['recoveryId'] ||
      (value['baseRevision'] !== null && !revision(value['baseRevision'])) || !object(value['record'])) {
    throw new Error('Invalid local recovery journal');
  }
  const record = value['record'];
  if (typeof record['id'] !== 'string' || !record['id'] || typeof record['name'] !== 'string' ||
      record['schemaVersion'] !== SCHEMA_VERSION || typeof record['updatedAt'] !== 'number' ||
      !Number.isFinite(record['updatedAt'])) throw new Error('Unsupported local recovery snapshot');
  const rawCamera = record['camera'];
  if (!object(rawCamera) || !['x', 'y', 'zoom'].every((field) =>
    typeof rawCamera[field] === 'number' && Number.isFinite(rawCamera[field]))) {
    throw new Error('Invalid recovery camera');
  }
  const doc = validateBoardDoc(record['doc']);
  const camera = validateCamera(record['camera']);
  if (doc.id !== record['id'] || doc.name !== record['name']) throw new Error('Recovery snapshot identity mismatch');
  return {
    key, sequence: value['sequence'], recoveryId: value['recoveryId'], baseRevision: value['baseRevision'],
    record: { id: doc.id, name: doc.name, schemaVersion: SCHEMA_VERSION, updatedAt: record['updatedAt'], doc, camera },
  };
}

function encode(entry: RecoveryEntry): string {
  return JSON.stringify({ ...entry, key: undefined, format: 1 });
}

function sameSnapshot(record: BoardRecord, snapshot: Snapshot): boolean {
  return record.schemaVersion === snapshot.schemaVersion && record.name === snapshot.name &&
    JSON.stringify(validateBoardDoc(record.doc)) === JSON.stringify(snapshot.doc) &&
    JSON.stringify(validateCamera(record.camera)) === JSON.stringify(snapshot.camera);
}

/** Synchronous write-ahead snapshots bridge browser termination before IndexedDB commits. */
export class RecoveryJournal {
  private readonly prefix: string;
  private readonly tab = createId();
  private sequence = 0;
  private release: (() => void) | undefined;

  constructor(private readonly storage: Storage, workspace: WorkspaceIdentity) {
    this.prefix = workspacePrefix(workspace);
  }

  async claim(locks?: LockManager): Promise<void> {
    if (!locks) return;
    await new Promise<void>((resolve, reject) => {
      void locks.request(this.prefix + this.tab, async () => {
        const lifetime = new Promise<void>((release) => { this.release = release; });
        resolve();
        await lifetime;
      }).catch(reject);
    });
  }

  close(): void { this.release?.(); }

  capture(record: Snapshot, baseRevision: number | null): RecoveryEntry {
    const key = this.prefix + this.tab + ':' + encodeURIComponent(record.id);
    const raw = this.storage.getItem(key);
    const previous = raw ? parse(key, raw) : null;
    const entry: RecoveryEntry = {
      key, sequence: ++this.sequence, recoveryId: previous?.recoveryId ?? createId(), baseRevision, record,
    };
    this.storage.setItem(key, encode(entry));
    return entry;
  }

  entries(): RecoveryEntry[] {
    const entries: RecoveryEntry[] = [];
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index);
      if (!key?.startsWith(this.prefix)) continue;
      const raw = this.storage.getItem(key);
      if (raw !== null) entries.push(parse(key, raw));
    }
    return entries;
  }

  acknowledge(entry: RecoveryEntry, savedRevision?: number): void {
    const raw = this.storage.getItem(entry.key);
    if (!raw) return;
    const current = parse(entry.key, raw);
    if (current.sequence === entry.sequence) this.storage.removeItem(entry.key);
    else if (current.sequence > entry.sequence && savedRevision !== undefined) {
      this.storage.setItem(entry.key, encode({ ...current, baseRevision: savedRevision }));
    }
  }

  discardBoard(id: string): void {
    for (const entry of this.entries()) if (entry.record.id === id) this.storage.removeItem(entry.key);
  }

  async recover(repo: BoardRepository, conflictName: (name: string) => string, locks?: LockManager): Promise<{ lastId?: string; conflicts: string[] }> {
    if (workspacePrefix(repo.workspace) !== this.prefix) throw new Error('Recovery workspace does not match the repository');
    let lastId: string | undefined;
    const conflicts: string[] = [];
    for (const entry of this.entries()) {
      if (repo.localDurability !== 'persistent') throw new Error('Recovery requires persistent board storage');
      const owner = entry.key.slice(0, entry.key.lastIndexOf(':'));
      const recover = async () => {
        // A tab may have committed/removed this entry while we waited for ownership.
        const raw = this.storage.getItem(entry.key);
        if (!raw) return;
        const latest = parse(entry.key, raw);
        if (latest.sequence !== entry.sequence) return;
        const current = await repo.load(entry.record.id);
        if (current && sameSnapshot(current, entry.record)) {
          this.acknowledge(entry, current.revision);
          lastId = current.id;
          return;
        }
        if (current && current.schemaVersion <= SCHEMA_VERSION && current.revision === entry.baseRevision) {
          try {
            const result = await repo.save(entry.record, current.revision);
            if (result.localDurability !== 'persistent') throw new Error('Recovery requires persistent board storage');
            this.acknowledge(entry, result.revision);
            lastId = current.id;
            return;
          } catch (error) {
            if (!(error instanceof RevisionConflictError)) throw error;
          }
        }
        // Missing/deleted or concurrently edited originals are never overwritten or resurrected.
        const name = conflictName(entry.record.name);
        const copy: Snapshot = { ...entry.record, id: entry.recoveryId, name, doc: { ...entry.record.doc, id: entry.recoveryId, name } };
        const existing = await repo.load(copy.id);
        if (existing && !sameSnapshot(existing, copy)) throw new Error('Recovery copy changed before recovery completed');
        if (!existing) {
          for (const node of Object.values(copy.doc.nodes)) {
            for (const meta of node.attachments ?? []) {
              if (await repo.getAttachment(copy.id, meta.id)) continue;
              const blob = await repo.getAttachment(entry.record.id, meta.id);
              if (!blob) throw new Error('Recovery attachment bytes are unavailable; original journal retained');
              await repo.putAttachment(copy.id, meta, blob, { nodeId: node.id, attachments: node.attachments ?? [] });
            }
          }
          const result = await repo.save(copy, null);
          if (result.localDurability !== 'persistent') throw new Error('Recovery requires persistent board storage');
        }
        if (this.storage.getItem(entry.key) === raw) this.storage.removeItem(entry.key);
        lastId = copy.id;
        conflicts.push(name);
      };
      if (locks) await locks.request(owner, { ifAvailable: true }, async (lock) => { if (lock) await recover(); });
      else await recover();
    }
    return { lastId, conflicts };
  }
}
