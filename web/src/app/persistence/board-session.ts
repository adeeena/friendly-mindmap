import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import {
  AttachmentMeta,
  BoardDoc,
  BoardSummary,
  MAX_ATTACHMENT_BYTES,
  SCHEMA_VERSION,
  StoredBoard,
  cloneJson,
  createBoard,
  createId,
} from '../core/model';
import { validateBoardDoc, validateCamera } from '../core/validate';
import { EditorStore } from '../editor/editor-store';
import { BOARD_REPOSITORY, BoardRepository, MemoryBoardRepository, RevisionConflictError } from './board-repository';
import { IndexedDbBoardRepository, probeIndexedDb } from './indexeddb-repository';
import { NewerSchemaError, migrateBoard } from './migrations';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export const AUTOSAVE_DEBOUNCE_MS = 800;
const LAST_BOARD_KEY = 'lastBoardId';

interface BroadcastMessage {
  type: 'saved' | 'deleted';
  boardId: string;
  revision: number;
  tab: string;
}

/** Owns the open board: autoload, autosave, boards list, multi-tab sync. */
@Injectable({ providedIn: 'root' })
export class BoardSession {
  private readonly store = inject(EditorStore);
  private readonly document = inject(DOCUMENT);
  private readonly injectedRepo = inject(BOARD_REPOSITORY, { optional: true });
  private repo: BoardRepository = this.injectedRepo ?? new MemoryBoardRepository();
  private readonly tabId = createId();
  private channel: BroadcastChannel | null = null;

  readonly status = signal<SaveStatus>('idle');
  readonly statusMessage = signal<string | null>(null);
  readonly boards = signal<BoardSummary[]>([]);
  readonly ready = signal(false);
  readonly storageWarning = signal<string | null>(null);
  readonly conflictMessage = signal<string | null>(null);

  private revision: number | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  private lastSavedVersion = -1;
  private savedCamera: unknown = null;

  constructor() {
    effect(() => {
      this.store.docVersion();
      this.store.camera();
      untracked(() => this.onChange());
    });
  }

  get repository(): BoardRepository {
    return this.repo;
  }

  async init(destroyRef?: DestroyRef): Promise<void> {
    if (!this.injectedRepo) {
      if (await probeIndexedDb()) this.repo = new IndexedDbBoardRepository();
      else {
        this.repo = new MemoryBoardRepository();
        this.storageWarning.set('On-device storage is unavailable. Changes will be lost on reload — export to keep them.');
      }
    }
    this.setupLifecycle(destroyRef);
    await this.refreshList();
    const last = await this.repo.getMeta<string>(LAST_BOARD_KEY).catch(() => undefined);
    const target = (last && this.boards().find((b) => b.id === last)?.id) ?? this.boards()[0]?.id;
    if (target) await this.open(target);
    else await this.create('Untitled board');
    this.ready.set(true);
  }

  private setupLifecycle(destroyRef?: DestroyRef): void {
    const flush = () => void this.flush();
    const onVisibility = () => {
      if (this.document.visibilityState === 'hidden') flush();
    };
    this.document.addEventListener('visibilitychange', onVisibility);
    this.document.defaultView?.addEventListener('pagehide', flush);
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('better-mindmap');
      this.channel.onmessage = (e: MessageEvent<BroadcastMessage>) => void this.onBroadcast(e.data);
    }
    destroyRef?.onDestroy(() => {
      this.document.removeEventListener('visibilitychange', onVisibility);
      this.document.defaultView?.removeEventListener('pagehide', flush);
      this.channel?.close();
    });
  }

  private onChange(): void {
    if (!this.ready()) return;
    if (this.store.docVersion() === this.lastSavedVersion && this.store.camera() === this.savedCamera) return;
    if (this.store.readOnly()) return;
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), AUTOSAVE_DEBOUNCE_MS);
  }

  /** Saves pending changes immediately. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.saving) await this.saving;
    if (!this.dirty || this.store.readOnly()) return;
    this.saving = this.save().finally(() => (this.saving = null));
    await this.saving;
  }

  private async save(): Promise<void> {
    const doc = this.store.doc();
    const camera = this.store.camera();
    const version = this.store.docVersion();
    this.dirty = false;
    this.status.set('saving');
    try {
      const { revision } = await this.repo.save(
        { id: doc.id, name: doc.name, schemaVersion: SCHEMA_VERSION, updatedAt: Date.now(), doc, camera },
        this.revision,
      );
      this.revision = revision;
      this.lastSavedVersion = version;
      this.savedCamera = camera;
      this.status.set('saved');
      this.statusMessage.set(null);
      this.channel?.postMessage({ type: 'saved', boardId: doc.id, revision, tab: this.tabId } satisfies BroadcastMessage);
      await this.refreshList();
    } catch (err) {
      if (err instanceof RevisionConflictError) {
        await this.resolveConflict();
        return;
      }
      this.dirty = true;
      this.status.set('error');
      this.statusMessage.set('Saving failed. Storage may be full or unavailable — export the board to keep your work.');
    }
  }

  /** Our unsaved edits collide with a newer save: keep ours as a copy, load theirs. */
  private async resolveConflict(): Promise<void> {
    const mine = cloneJson(this.store.doc());
    const copyName = `${mine.name} (conflict copy)`;
    const copy: BoardDoc = { ...mine, id: createId(), name: copyName };
    await this.repo.save(
      { id: copy.id, name: copy.name, schemaVersion: SCHEMA_VERSION, updatedAt: Date.now(), doc: copy, camera: this.store.camera() },
      null,
    );
    this.conflictMessage.set(`This board was changed in another tab. Your version was kept as “${copyName}”.`);
    await this.open(mine.id, { keepCamera: true });
  }

  private async onBroadcast(msg: BroadcastMessage): Promise<void> {
    if (msg.tab === this.tabId) return;
    if (msg.type === 'deleted') {
      await this.refreshList();
      if (msg.boardId === this.store.doc().id) await this.openMostRecentOrCreate();
      return;
    }
    await this.refreshList();
    if (msg.boardId !== this.store.doc().id || (this.revision ?? 0) >= msg.revision) return;
    // Camera-only changes are not worth a conflict copy.
    const pending = this.store.docVersion() !== this.lastSavedVersion;
    if (pending) await this.resolveConflict();
    else await this.open(msg.boardId, { keepCamera: true });
  }

  async refreshList(): Promise<void> {
    try {
      this.boards.set(await this.repo.list());
    } catch {
      /* listing failure is non-fatal */
    }
  }

  async open(id: string, opts: { keepCamera?: boolean } = {}): Promise<boolean> {
    if (id !== this.store.doc().id) await this.flush();
    const record = await this.repo.load(id);
    if (!record) return false;
    let board: StoredBoard;
    let readOnly = false;
    try {
      board = migrateBoard(record);
    } catch (err) {
      if (!(err instanceof NewerSchemaError)) throw err;
      readOnly = true;
      board = {
        schemaVersion: err.version,
        revision: record.revision,
        updatedAt: record.updatedAt,
        doc: validateBoardDoc(record.doc),
        camera: validateCamera(record.camera),
      };
      this.statusMessage.set('This board was saved by a newer version of the app. It is open read-only and will not be overwritten.');
    }
    const camera = opts.keepCamera ? this.store.camera() : board.camera;
    this.store.loadBoard({ doc: board.doc, camera }, readOnly);
    this.revision = record.revision;
    this.dirty = false;
    this.lastSavedVersion = this.store.docVersion();
    this.savedCamera = this.store.camera();
    if (!readOnly) this.statusMessage.set(null);
    this.status.set('saved');
    await this.repo.setMeta(LAST_BOARD_KEY, id).catch(() => undefined);
    void this.collectOrphanAttachments(board.doc);
    return true;
  }

  async create(name: string, doc?: BoardDoc): Promise<string> {
    await this.flush();
    const board = doc ?? createBoard(name);
    const camera = { x: (this.store.viewport().w / 2) | 0, y: (this.store.viewport().h / 3) | 0, zoom: 1 };
    await this.repo.save({ id: board.id, name: board.name, schemaVersion: SCHEMA_VERSION, updatedAt: Date.now(), doc: board, camera }, null);
    await this.refreshList();
    await this.open(board.id);
    return board.id;
  }

  async rename(id: string, name: string): Promise<void> {
    const clean = name.trim().slice(0, 200) || 'Untitled board';
    if (id === this.store.doc().id) {
      this.store.renameBoard(clean);
      await this.flush();
      return;
    }
    const rec = await this.repo.load(id);
    if (!rec) return;
    const doc = { ...(rec.doc as BoardDoc), name: clean };
    await this.repo.save({ ...rec, name: clean, doc, updatedAt: Date.now() }, rec.revision);
    await this.refreshList();
  }

  async duplicate(id: string): Promise<string | null> {
    await this.flush();
    const rec = await this.repo.load(id);
    if (!rec) return null;
    const src = migrateBoard(rec);
    const copy: BoardDoc = { ...cloneJson(src.doc), id: createId(), name: `${src.doc.name} copy` };
    await this.repo.save(
      { id: copy.id, name: copy.name, schemaVersion: SCHEMA_VERSION, updatedAt: Date.now(), doc: copy, camera: src.camera },
      null,
    );
    for (const attId of await this.repo.listAttachmentIds(id)) {
      const blob = await this.repo.getAttachment(id, attId);
      const meta = this.findAttachmentMeta(src.doc, attId);
      if (blob && meta) await this.repo.putAttachment(copy.id, meta, blob);
    }
    await this.refreshList();
    return copy.id;
  }

  async remove(id: string): Promise<void> {
    await this.repo.delete(id);
    this.channel?.postMessage({ type: 'deleted', boardId: id, revision: 0, tab: this.tabId } satisfies BroadcastMessage);
    await this.refreshList();
    if (id === this.store.doc().id) {
      this.dirty = false;
      await this.openMostRecentOrCreate();
    }
  }

  private async openMostRecentOrCreate(): Promise<void> {
    const next = this.boards()[0];
    if (next) await this.open(next.id);
    else await this.create('Untitled board');
  }

  // --------------------------------------------------------- attachments

  async attach(nodeId: string, file: File): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return { ok: false, reason: `“${file.name}” is larger than the 10 MB limit.` };
    }
    const meta: AttachmentMeta = { id: createId(), name: file.name, mime: file.type || 'application/octet-stream', size: file.size };
    try {
      await this.repo.putAttachment(this.store.doc().id, meta, file);
    } catch {
      return { ok: false, reason: 'The file could not be stored on this device.' };
    }
    this.store.mutate(
      (d) => {
        const n = d.nodes[nodeId];
        if (n) (n.attachments ??= []).push(meta);
      },
      { label: 'Attach file' },
    );
    return { ok: true };
  }

  getAttachment(attachmentId: string): Promise<Blob | null> {
    return this.repo.getAttachment(this.store.doc().id, attachmentId);
  }

  private findAttachmentMeta(doc: BoardDoc, id: string): AttachmentMeta | undefined {
    for (const n of Object.values(doc.nodes)) {
      const a = n.attachments?.find((x) => x.id === id);
      if (a) return a;
    }
    return undefined;
  }

  /** Removes stored files no longer referenced; runs on open so undo can still restore within a session. */
  private async collectOrphanAttachments(doc: BoardDoc): Promise<void> {
    try {
      const stored = await this.repo.listAttachmentIds(doc.id);
      const used = new Set(Object.values(doc.nodes).flatMap((n) => n.attachments?.map((a) => a.id) ?? []));
      await Promise.all(stored.filter((id) => !used.has(id)).map((id) => this.repo.deleteAttachment(doc.id, id)));
    } catch {
      /* best effort */
    }
  }
}
