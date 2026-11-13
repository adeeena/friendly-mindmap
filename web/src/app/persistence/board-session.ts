import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import {
  AttachmentMeta,
  BoardDoc,
  BoardSummary,
  SCHEMA_VERSION,
  StoredBoard,
  cloneJson,
  createBoard,
  createId,
} from '../core/model';
import { validateBoardDoc, validateCamera } from '../core/validate';
import { EditorStore } from '../editor/editor-store';
import { Msg, t } from '../i18n';
import {
  AttachmentPolicyError, BOARD_REPOSITORY, BoardRepository, MemoryBoardRepository, RevisionConflictError, assertAttachmentWrite,
} from './board-repository';
import { attachmentPolicyViolation } from '../../../../shared/attachment-policy';
import { IndexedDbBoardRepository, probeIndexedDb } from './indexeddb-repository';
import { NewerSchemaError, migrateBoard } from './migrations';
import { RecoveryEntry, RecoveryJournal } from './recovery-journal';
import type { ImportedBoard } from '../io/native-format';

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
  private readonly destroyRef = inject(DestroyRef);
  private readonly injectedRepo = inject(BOARD_REPOSITORY, { optional: true });
  private repo: BoardRepository = this.injectedRepo ?? new MemoryBoardRepository();
  private readonly tabId = createId();
  private channel: BroadcastChannel | null = null;

  readonly status = signal<SaveStatus>('idle');
  readonly statusMessage = signal<Msg | null>(null);
  readonly boards = signal<BoardSummary[]>([]);
  readonly ready = signal(false);
  readonly storageWarning = signal<Msg | null>(null);
  readonly conflictMessage = signal<Msg | null>(null);

  private revision: number | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  private lastSavedVersion = -1;
  private savedCamera: unknown = null;
  private readonly attaching = new Set<string>();
  private journal: RecoveryJournal | null = null;
  private recovery: RecoveryEntry | null = null;
  private journalFailed = false;
  private initialized = false;
  private lifecycleSetup = false;
  private generation = 0;

  constructor() {
    const unsubscribe = this.store.onDocumentChange(() => {
      this.onChange();
      void this.flush();
    });
    inject(DestroyRef).onDestroy(unsubscribe);
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
    if (!this.initialized && !this.injectedRepo) {
      if (await probeIndexedDb()) this.repo = new IndexedDbBoardRepository();
      else {
        this.repo = new MemoryBoardRepository();
        this.storageWarning.set({ key: 'msg.storageUnavailable' });
      }
    }
    this.initialized = true;
    this.setupLifecycle(destroyRef);
    this.channel?.close();
    if (typeof BroadcastChannel !== 'undefined') {
      const workspace = this.repo.workspace;
      const name = workspace.kind === 'guest' ? 'guest' : `account:${workspace.accountId}`;
      this.channel = new BroadcastChannel('better-mindmap:' + name);
      this.channel.onmessage = (e: MessageEvent<BroadcastMessage>) => {
        void this.onBroadcast(e.data).catch(() => {
          this.status.set('error');
          this.statusMessage.set({ key: 'msg.saveFailed' });
        });
      };
    }
    let recoveredId: string | undefined;
    try {
      const storage = this.document.defaultView?.localStorage;
      if (!storage) throw new Error('Recovery storage unavailable');
      this.journal = new RecoveryJournal(storage, this.repo.workspace);
      const locks = this.document.defaultView?.navigator.locks;
      await this.journal.claim(locks);
      const recovered = await this.journal.recover(this.repo, (name) => t('board.conflictCopy', { name }), locks);
      recoveredId = recovered.lastId;
      if (recovered.conflicts.length) {
        this.conflictMessage.set({ key: 'msg.conflict', params: { name: recovered.conflicts.join(', ') } });
      }
    } catch {
      this.storageWarning.set({ key: 'msg.recoveryUnavailable' });
    }
    await this.refreshList();
    const last = await this.repo.getMeta<string>(LAST_BOARD_KEY).catch(() => undefined);
    const target = recoveredId ?? (last && this.boards().find((b) => b.id === last)?.id) ?? this.boards()[0]?.id;
    if (target) await this.open(target);
    else await this.create(t('board.untitled'));
    this.ready.set(true);
  }

  async switchRepository(repository: BoardRepository): Promise<void> {
    await this.flush();
    if (this.dirty) throw new Error(t('msg.saveFailed'));
    this.ready.set(false);
    this.generation++;
    this.journal?.close();
    this.journal = null;
    this.recovery = null;
    this.repo = repository;
    this.revision = null;
    this.lastSavedVersion = -1;
    this.savedCamera = null;
    this.boards.set([]);
    this.statusMessage.set(null);
    this.storageWarning.set(null);
    this.conflictMessage.set(null);
    this.store.loadBoard({ doc: createBoard(), camera: { x: 0, y: 0, zoom: 1 } }, true);
    await this.init();
  }

  async prepareWorkspaceTransition(): Promise<() => void> {
    const readOnly = this.store.readOnly();
    this.onChange();
    this.store.readOnly.set(true);
    try {
      await this.flushPending(true);
      if (this.dirty) throw new Error(t('msg.saveFailed'));
    } catch (error) {
      this.store.readOnly.set(readOnly);
      throw error;
    }
    this.store.readOnly.set(true);
    return () => this.store.readOnly.set(readOnly);
  }

  private setupLifecycle(destroyRef?: DestroyRef): void {
    if (this.lifecycleSetup) return;
    this.lifecycleSetup = true;
    const flush = () => {
      this.onChange();
      void this.flush();
    };
    const onVisibility = () => {
      if (this.document.visibilityState === 'hidden') flush();
    };
    this.document.addEventListener('visibilitychange', onVisibility);
    this.document.defaultView?.addEventListener('pagehide', flush);
    (destroyRef ?? this.destroyRef).onDestroy(() => {
      this.document.removeEventListener('visibilitychange', onVisibility);
      this.document.defaultView?.removeEventListener('pagehide', flush);
      this.channel?.close();
      this.journal?.close();
    });
  }

  private onChange(): void {
    if (!this.ready()) return;
    if (this.store.docVersion() === this.lastSavedVersion && this.store.camera() === this.savedCamera) return;
    if (this.store.readOnly()) return;
    this.dirty = true;
    try {
      this.recovery = this.journal?.capture({
        id: this.store.doc().id, name: this.store.doc().name, schemaVersion: SCHEMA_VERSION,
        updatedAt: Date.now(), doc: this.store.doc(), camera: this.store.camera(),
      }, this.revision) ?? null;
      this.journalFailed = !this.journal;
    } catch {
      this.journalFailed = true;
    }
    if (this.journalFailed) this.storageWarning.set({ key: 'msg.recoveryUnavailable' });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), AUTOSAVE_DEBOUNCE_MS);
  }

  /** Commits the current edits to local storage right now and reports whether they are durable. */
  async saveNow(): Promise<{ ok: boolean; boardId: string; revision: number | null }> {
    const boardId = this.store.doc().id;
    this.onChange();
    await this.flush();
    return { ok: !this.dirty && this.status() !== 'error' && !this.store.readOnly(), boardId, revision: this.revision };
  }

  /** Saves pending changes immediately. */
  async flush(): Promise<void> {
    await this.flushPending(false);
  }

  private async flushPending(whileReadOnly: boolean): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.saving) await this.saving;
    if (!this.dirty || (this.store.readOnly() && !whileReadOnly)) return;
    this.saving = this.save().finally(() => (this.saving = null));
    await this.saving;
  }

  private async save(): Promise<void> {
    const doc = this.store.doc();
    const camera = this.store.camera();
    const version = this.store.docVersion();
    const recovery = this.recovery;
    this.dirty = false;
    this.status.set('saving');
    try {
      const { revision, localDurability } = await this.repo.save(
        { id: doc.id, name: doc.name, schemaVersion: SCHEMA_VERSION, updatedAt: Date.now(), doc, camera },
        this.revision,
      );
      this.revision = revision;
      if (recovery && localDurability === 'persistent') {
        try { this.journal?.acknowledge(recovery, revision); }
        catch { this.storageWarning.set({ key: 'msg.recoveryUnavailable' }); }
      }
      this.lastSavedVersion = version;
      this.savedCamera = camera;
      this.status.set(this.dirty ? 'saving' : 'saved');
      this.statusMessage.set(null);
      this.channel?.postMessage({ type: 'saved', boardId: doc.id, revision, tab: this.tabId } satisfies BroadcastMessage);
      await this.refreshList();
    } catch (err) {
      if (err instanceof RevisionConflictError) {
        try { await this.resolveConflict(); }
        catch {
          this.dirty = true;
          this.status.set('error');
          this.statusMessage.set({ key: 'msg.saveFailed' });
        }
        return;
      }
      this.dirty = true;
      this.status.set('error');
      this.statusMessage.set({ key: 'msg.saveFailed' });
    }
  }

  /** Our unsaved edits collide with a newer save: keep ours as a copy, load theirs. */
  private async resolveConflict(): Promise<void> {
    const generation = this.generation;
    const readOnly = this.store.readOnly();
    const version = this.store.docVersion();
    const recovery = this.recovery;
    const mine = cloneJson(this.store.doc());
    const copyName = t('board.conflictCopy', { name: mine.name });
    const repository = this.repo;
    this.store.readOnly.set(true);
    let opened = false;
    try {
      const copy = await this.persistCopy(mine, this.store.camera(), copyName, repository);
      if (generation !== this.generation) return;
      if (recovery && repository.localDurability === 'persistent') {
        try { this.journal?.acknowledge(recovery); }
        catch { this.storageWarning.set({ key: 'msg.recoveryUnavailable' }); }
      }
      this.conflictMessage.set({ key: 'msg.conflict', params: { name: copyName } });
      if (version !== this.store.docVersion()) { this.dirty = true; return; }
      opened = await this.openPersisted(mine.id, { keepCamera: true }) || await this.openPersisted(copy.id, { keepCamera: true });
    } finally { if (!opened && generation === this.generation) this.store.readOnly.set(readOnly); }
  }

  private async onBroadcast(msg: BroadcastMessage): Promise<void> {
    const generation = this.generation;
    if (msg.tab === this.tabId) return;
    if (msg.type === 'deleted') {
      await this.refreshList();
      if (generation !== this.generation) return;
      if (msg.boardId === this.store.doc().id) await this.openMostRecentOrCreate();
      return;
    }

    await this.refreshList();
    if (generation !== this.generation) return;
    if (msg.boardId !== this.store.doc().id || (this.revision ?? 0) >= msg.revision) return;
    // Camera-only changes are not worth a conflict copy.
    const pending = this.store.docVersion() !== this.lastSavedVersion;
    if (pending) await this.resolveConflict();
    else await this.open(msg.boardId, { keepCamera: true });
  }

  async remoteChanged(change: { id: string; revision: number; deleted: boolean }): Promise<void> {
    const generation = this.generation;
    await this.flush();
    if (generation !== this.generation || this.status() === 'error') return;
    const message: BroadcastMessage = {
      type: change.deleted ? 'deleted' : 'saved', boardId: change.id, revision: change.revision, tab: 'cloud-sync',
    };
    await this.onBroadcast(message);
    if (generation === this.generation) this.channel?.postMessage({ ...message, tab: this.tabId });
  }

  async refreshList(): Promise<void> {
    const generation = this.generation;
    const repository = this.repo;
    try {
      const boards = await repository.list();
      if (generation === this.generation) this.boards.set(boards);
    } catch {
      /* listing failure is non-fatal */
    }
  }

  async open(id: string, opts: { keepCamera?: boolean } = {}): Promise<boolean> {
    const generation = this.generation;
    if (id !== this.store.doc().id) await this.flush();
    if (generation !== this.generation) return false;
    return this.openPersisted(id, opts);
  }

  private async openPersisted(id: string, opts: { keepCamera?: boolean }): Promise<boolean> {
    const generation = this.generation;
    const repository = this.repo;
    const record = await repository.load(id);
    if (generation !== this.generation) return false;
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
      this.statusMessage.set({ key: 'msg.newerSchema' });
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
    const generation = this.generation;
    const repository = this.repo;
    const board = doc ?? createBoard(name);
    const camera = { x: (this.store.viewport().w / 2) | 0, y: (this.store.viewport().h / 3) | 0, zoom: 1 };
    await repository.save({ id: board.id, name: board.name, schemaVersion: SCHEMA_VERSION, updatedAt: Date.now(), doc: board, camera }, null);
    if (generation !== this.generation) throw new Error('Workspace changed during board creation');
    await this.refreshList();
    await this.open(board.id);
    return board.id;
  }

  /**
   * Staged native import: file bytes are written under the new board before the board itself is
   * published, so a cloud workspace never queues a board whose files are missing. Account imports
   * get fresh attachment identities and drop references whose bytes were not in the file.
   */
  async importBoard(imported: ImportedBoard): Promise<{ id: string; dropped: string[] }> {
    await this.flush();
    const generation = this.generation;
    const repository = this.repo;
    const account = repository.workspace.kind === 'account';
    const doc: BoardDoc = { ...cloneJson(imported.board.doc), id: createId() };
    const available = new Map(imported.files.map((file) => [file.meta.id, file]));
    const dropped: string[] = [];
    const writes: { meta: AttachmentMeta; blob: Blob; context: { nodeId: string; attachments: AttachmentMeta[] } }[] = [];
    for (const node of Object.values(doc.nodes)) {
      const violation = attachmentPolicyViolation(repository.attachmentRole, node.attachments?.map((a) => a.size) ?? []);
      if (violation) throw new AttachmentPolicyError(violation);
      if (!node.attachments?.length) continue;
      const kept: AttachmentMeta[] = [];
      for (const meta of node.attachments) {
        const file = available.get(meta.id);
        if (!file && account) { dropped.push(meta.name); continue; }
        const next = account ? { ...meta, id: createId() } : meta;
        kept.push(next);
        if (file) writes.push({ meta: next, blob: file.blob, context: { nodeId: node.id, attachments: kept } });
      }
      if (kept.length) node.attachments = kept; else delete node.attachments;
    }
    for (const write of writes) assertAttachmentWrite(repository.attachmentRole, write.meta, write.blob, write.context);
    const staged: string[] = [];
    try {
      for (const write of writes) {
        await repository.putAttachment(doc.id, write.meta, write.blob, write.context);
        staged.push(write.meta.id);
      }
      await repository.save(
        { id: doc.id, name: doc.name, schemaVersion: SCHEMA_VERSION, updatedAt: Date.now(), doc, camera: imported.board.camera },
        null,
      );
      if (generation !== this.generation) throw new Error('Workspace changed during import');
    } catch (error) {
      const cleanup = await Promise.allSettled(staged.map((id) => repository.deleteAttachment(doc.id, id)));
      const failures = cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (failures.length) throw new AggregateError([error, ...failures], 'Board import and staged-file cleanup failed');
      throw error;
    }
    await this.refreshList();
    await this.open(doc.id);
    return { id: doc.id, dropped };
  }

  async rename(id: string, name: string): Promise<void> {
    const repository = this.repo;
    const generation = this.generation;
    const clean = name.trim().slice(0, 200) || t('board.untitled');
    if (id === this.store.doc().id) {
      this.store.renameBoard(clean);
      await this.flush();
      return;
    }
    const rec = await repository.load(id);
    if (generation !== this.generation) return;
    if (!rec) return;
    const doc = { ...(rec.doc as BoardDoc), name: clean };
    await repository.save({ ...rec, name: clean, doc, updatedAt: Date.now() }, rec.revision);
    if (generation !== this.generation) return;
    await this.refreshList();
  }

  async duplicate(id: string): Promise<string | null> {
    await this.flush();
    const repository = this.repo;
    const generation = this.generation;
    const rec = await repository.load(id);
    if (generation !== this.generation) return null;
    if (!rec) return null;
    const src = migrateBoard(rec);
    for (const node of Object.values(src.doc.nodes)) {
      const violation = attachmentPolicyViolation(repository.attachmentRole, node.attachments?.map((a) => a.size) ?? []);
      if (violation) throw new AttachmentPolicyError(violation);
    }
    const copy = await this.persistCopy(src.doc, src.camera, t('board.copy', { name: src.doc.name }), repository);
    if (generation !== this.generation) return null;
    await this.refreshList();
    return copy.id;
  }

  private async persistCopy(doc: BoardDoc, camera: unknown, name: string, repository: BoardRepository): Promise<BoardDoc> {
    const copy: BoardDoc = { ...cloneJson(doc), id: createId(), name: name.slice(0, 200) };
    const staged: string[] = [];
    try {
      for (const node of Object.values(copy.nodes)) {
        for (const meta of node.attachments ?? []) {
          const sourceId = meta.id;
          if (repository.workspace.kind === 'account') meta.id = createId();
          const context = { nodeId: node.id, attachments: node.attachments ?? [] };
          if (repository.copyAttachment) await repository.copyAttachment(doc.id, sourceId, copy.id, meta, context);
          else {
            const blob = await repository.getAttachment(doc.id, sourceId);
            if (!blob) throw new Error('An attachment is unavailable; the board has not been duplicated');
            await repository.putAttachment(copy.id, meta, blob, context);
          }
          staged.push(meta.id);
        }
      }
      await repository.save(
        { id: copy.id, name: copy.name, schemaVersion: SCHEMA_VERSION, updatedAt: Date.now(), doc: copy, camera },
        null,
      );
    } catch (error) {
      const cleanup = await Promise.allSettled(staged.map((attachmentId) => repository.deleteAttachment(copy.id, attachmentId)));
      const failures = cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (failures.length) throw new AggregateError([error, ...failures], 'Board duplication and staged-file cleanup failed');
      throw error;
    }
    return copy;
  }

  async remove(id: string): Promise<void> {
    await this.flush();
    const repository = this.repo;
    const generation = this.generation;
    await repository.delete(id);
    if (generation !== this.generation) return;
    try { this.journal?.discardBoard(id); }
    catch { this.storageWarning.set({ key: 'msg.recoveryUnavailable' }); }
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
    else await this.create(t('board.untitled'));
  }

  // --------------------------------------------------------- attachments

  async attach(nodeId: string, file: File): Promise<{ ok: true } | { ok: false; reason: string }> {
    const repository = this.repo;
    const generation = this.generation;
    const boardId = this.store.doc().id;
    const node = this.store.doc().nodes[nodeId];
    if (!node || this.store.readOnly()) return { ok: false, reason: t('error.attachFailed') };
    const slot = `${boardId}/${nodeId}`;
    if (this.repo.attachmentRole !== 'admin' && this.attaching.has(slot)) return { ok: false, reason: t('error.attachCount') };
    const meta: AttachmentMeta = { id: createId(), name: file.name, mime: file.type || 'application/octet-stream', size: file.size };
    try {
      const context = { nodeId, attachments: node.attachments ?? [] };
      assertAttachmentWrite(this.repo.attachmentRole, meta, file, context);
      this.attaching.add(slot);
      await repository.putAttachment(boardId, meta, file, context);
      if (generation !== this.generation || this.store.doc().id !== boardId || !this.store.doc().nodes[nodeId]) {
        await repository.deleteAttachment(boardId, meta.id);
        return { ok: false, reason: t('error.attachFailed') };
      }
      this.store.mutate((d) => { (d.nodes[nodeId].attachments ??= []).push(meta); }, { label: 'Attach file' });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: this.attachFailure(error, file.name) };
    } finally {
      this.attaching.delete(slot);
    }
  }

  /**
   * Swaps one attachment's file for another (for example an optimised copy of the same image) in place, as a
   * single undoable change. The replacement counts instead of the original, so it is allowed at the one-file
   * limit; the original's bytes stay until the board is next opened so undo can still restore them.
   */
  async replaceAttachment(nodeId: string, attachmentId: string, file: File): Promise<{ ok: true } | { ok: false; reason: string }> {
    const repository = this.repo;
    const generation = this.generation;
    const boardId = this.store.doc().id;
    const node = this.store.doc().nodes[nodeId];
    if (!node?.attachments?.some((a) => a.id === attachmentId) || this.store.readOnly()) {
      return { ok: false, reason: t('error.attachFailed') };
    }
    const slot = `${boardId}/${nodeId}`;
    if (repository.attachmentRole !== 'admin' && this.attaching.has(slot)) return { ok: false, reason: t('error.attachCount') };
    const meta: AttachmentMeta = { id: createId(), name: file.name, mime: file.type || 'application/octet-stream', size: file.size };
    try {
      const context = { nodeId, attachments: node.attachments.filter((a) => a.id !== attachmentId) };
      assertAttachmentWrite(repository.attachmentRole, meta, file, context);
      this.attaching.add(slot);
      await repository.putAttachment(boardId, meta, file, context);
      const stillThere = generation === this.generation && this.store.doc().id === boardId &&
        this.store.doc().nodes[nodeId]?.attachments?.some((a) => a.id === attachmentId);
      if (!stillThere) {
        await repository.deleteAttachment(boardId, meta.id);
        return { ok: false, reason: t('error.attachFailed') };
      }
      this.store.mutate((d) => {
        const files = d.nodes[nodeId].attachments!;
        files[files.findIndex((a) => a.id === attachmentId)] = meta;
      }, { label: 'Optimise image' });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: this.attachFailure(error, file.name) };
    } finally {
      this.attaching.delete(slot);
    }
  }

  private attachFailure(error: unknown, name: string): string {
    if (error instanceof AttachmentPolicyError && error.violation === 'size') return t('error.attachTooLarge', { name });
    if (error instanceof AttachmentPolicyError && error.violation === 'count') return t('error.attachCount');
    if (error instanceof DOMException && error.name === 'QuotaExceededError') return t('error.attachQuota', { name });
    return t('error.attachFailed');
  }

  async getAttachment(attachmentId: string): Promise<Blob | null> {
    const generation = this.generation;
    const blob = await this.repo.getAttachment(this.store.doc().id, attachmentId);
    if (generation !== this.generation) throw new Error('Workspace changed during attachment retrieval');
    return blob;
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
    const repository = this.repo;
    try {
      if (repository.workspace.kind !== 'guest') {
        await repository.collectUnreferencedAttachments?.(doc.id);
        return;
      }
      const stored = await repository.listAttachmentIds(doc.id);
      const used = new Set(Object.values(doc.nodes).flatMap((n) => n.attachments?.map((a) => a.id) ?? []));
      await Promise.all(stored.filter((id) => !used.has(id)).map((id) => repository.deleteAttachment(doc.id, id)));
    } catch {
      /* best effort */
    }
  }
}
