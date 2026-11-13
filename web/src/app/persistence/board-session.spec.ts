import { TestBed } from '@angular/core/testing';
import { removeAttachment } from '../core/commands';
import { createBoard, createNode, ROOT_KEY, SCHEMA_VERSION } from '../core/model';
import { EditorStore } from '../editor/editor-store';
import { BOARD_REPOSITORY, MemoryBoardRepository } from './board-repository';
import { BoardSession } from './board-session';

describe('guest attachment session', () => {
  let repo: MemoryBoardRepository;
  let session: BoardSession;
  let store: EditorStore;

  beforeEach(() => {
    localStorage.clear();
    repo = new MemoryBoardRepository();
    TestBed.configureTestingModule({ providers: [{ provide: BOARD_REPOSITORY, useValue: repo }] });
    session = TestBed.inject(BoardSession);
    store = TestBed.inject(EditorStore);
    const doc = createBoard('Guest', 'guest');
    doc.nodes['node'] = createNode({ id: 'node' });
    doc.children[ROOT_KEY] = ['node'];
    store.loadBoard({ doc, camera: { x: 0, y: 0, zoom: 1 } });
  });

  it('opens a preserved copy when the original was deleted without awaiting its own in-flight save', async () => {
    const doc = store.doc();
    await repo.save({ id: doc.id, name: doc.name, doc, schemaVersion: SCHEMA_VERSION,
      updatedAt: Date.now(), camera: store.camera() }, null);
    await session.init();
    await repo.delete(doc.id);
    store.renameBoard('Local after deletion');
    await session.flush();
    expect(store.doc().id).not.toBe(doc.id);
    expect(store.doc().name).toContain('Local after deletion');
    expect(await repo.load(doc.id)).toBeNull();
    expect(store.readOnly()).toBe(false);
  });

  it('preserves attachment bytes when unsaved editor work collides with an external local revision', async () => {
    const doc = store.doc();
    await repo.save({ id: doc.id, name: doc.name, doc, schemaVersion: SCHEMA_VERSION,
      updatedAt: Date.now(), camera: store.camera() }, null);
    await session.init();
    expect(await session.attach('node', new File(['Local bytes'], 'keep.txt'))).toEqual({ ok: true });
    await session.flush();
    const before = (await repo.load(doc.id))!;
    const mine = store.doc();
    const meta = mine.nodes['node']!.attachments![0]!;
    await repo.save({ ...before, name: 'External edit', doc: { ...mine, name: 'External edit' } }, before.revision);
    store.renameBoard('Local edit');
    await session.flush();
    const copy = (await repo.list()).find((board) => board.id !== doc.id)!;
    expect(copy.name).toContain('Local edit');
    expect((await repo.getAttachment(copy.id, meta.id))?.size).toBe(11);
    expect((await repo.load(doc.id))?.name).toBe('External edit');
    expect(store.doc().name).toBe('External edit');
    expect(store.readOnly()).toBe(false);
  });

  it('surfaces recovery storage failures while still attempting IndexedDB persistence', async () => {
    const doc = store.doc();
    await repo.save({ id: doc.id, name: doc.name, doc, schemaVersion: SCHEMA_VERSION,
      updatedAt: Date.now(), camera: store.camera() }, null);
    await session.init();
    const quota = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Device storage is full', 'QuotaExceededError');
    });

    try {
      store.renameBoard('Durable without journal');
      await session.flush();
      expect((await repo.load('guest'))?.name).toBe('Durable without journal');
      expect(session.storageWarning()?.key).toBe('msg.recoveryUnavailable');
    } finally { quota.mockRestore(); }
  });

  it('reports an interrupted local write as not saved, keeps the edit dirty and succeeds once storage recovers', async () => {
    const doc = store.doc();
    await repo.save({ id: doc.id, name: doc.name, doc, schemaVersion: SCHEMA_VERSION,
      updatedAt: Date.now(), camera: store.camera() }, null);
    await session.init();
    const interrupted = jest.spyOn(repo, 'save').mockRejectedValue(new DOMException('Device storage is full', 'QuotaExceededError'));
    store.renameBoard('Interrupted write');
    const failed = await session.saveNow();
    expect(failed.ok).toBe(false);
    expect(session.status()).toBe('error');
    expect((await repo.load('guest'))?.name).not.toBe('Interrupted write');
    interrupted.mockRestore();
    const retried = await session.saveNow();
    expect(retried.ok).toBe(true);
    expect((await repo.load('guest'))?.name).toBe('Interrupted write');
  });

  it('retains the recovery journal after a memory-only save', async () => {
    const doc = store.doc();
    await repo.save({ id: doc.id, name: doc.name, doc, schemaVersion: SCHEMA_VERSION,
      updatedAt: Date.now(), camera: store.camera() }, null);
    await session.init();
    store.renameBoard('Memory fallback');
    await session.flush();
    expect(Object.keys(localStorage).some((key) => key.startsWith('better-mindmap-recovery:guest:'))).toBe(true);
  });

  it('does not journal or save a read-only board', async () => {
    const doc = store.doc();
    await repo.save({ id: doc.id, name: doc.name, doc, schemaVersion: SCHEMA_VERSION,
      updatedAt: Date.now(), camera: store.camera() }, null);
    await session.init();
    const save = jest.spyOn(repo, 'save');
    store.readOnly.set(true);
    store.renameBoard('Do not persist');
    await session.flush();
    expect(save).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
  it('accepts exact 5 MiB, rejects a second file, and rejects boundary plus one', async () => {
    const exact = new File([new Uint8Array(5_242_880)], 'exact.bin');
    expect(await session.attach('node', exact)).toEqual({ ok: true });
    expect(await session.attach('node', new File(['x'], 'second.txt'))).toEqual({
      ok: false, reason: 'Only one attachment per block is allowed.',
    });
    expect(await session.attach('node', new File([new Uint8Array(5_242_881)], 'large.bin'))).toEqual({
      ok: false, reason: '“large.bin” is larger than the 5 MiB limit.',
    });
    expect(store.doc().nodes['node'].attachments).toHaveLength(1);
  });

  it('reserves an in-flight local node slot', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const put = repo.putAttachment.bind(repo);
    jest.spyOn(repo, 'putAttachment').mockImplementation(async (...args) => { await gate; await put(...args); });
    const first = session.attach('node', new File(['one'], 'first.txt'));
    expect(await session.attach('node', new File(['two'], 'second.txt'))).toMatchObject({ ok: false });
    release();
    expect(await first).toEqual({ ok: true });
    expect(store.doc().nodes['node'].attachments).toHaveLength(1);
  });

  it('does not attach a delayed file to a different board', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const put = repo.putAttachment.bind(repo);
    jest.spyOn(repo, 'putAttachment').mockImplementation(async (...args) => { await gate; await put(...args); });
    const attaching = session.attach('node', new File(['one'], 'file.txt'));
    const other = createBoard('Other', 'other');
    other.nodes['node'] = createNode({ id: 'node' });
    other.children[ROOT_KEY] = ['node'];
    store.loadBoard({ doc: other, camera: { x: 0, y: 0, zoom: 1 } });
    release();
    expect(await attaching).toMatchObject({ ok: false });
    expect(store.doc().nodes['node'].attachments).toBeUndefined();
    expect(await repo.listAttachmentIds('guest')).toEqual([]);
  });

  it('starts local persistence synchronously with a document mutation, before the autosave delay', async () => {
    session.ready.set(true);
    const save = jest.spyOn(repo, 'save');
    store.renameBoard('Immediate');
    expect(save).toHaveBeenCalledTimes(1);
    await session.flush();
    expect((await repo.load('guest'))?.name).toBe('Immediate');
  });

  it('does not mark newer edits saved when an older in-flight snapshot completes', async () => {
    session.ready.set(true);
    let first!: () => void;
    let second!: () => void;
    const firstGate = new Promise<void>((resolve) => { first = resolve; });
    const secondGate = new Promise<void>((resolve) => { second = resolve; });
    const save = repo.save.bind(repo);
    let calls = 0;
    jest.spyOn(repo, 'save').mockImplementation(async (...args) => {
      await (++calls === 1 ? firstGate : secondGate);
      return save(...args);
    });
    store.renameBoard('First');
    store.renameBoard('Second');
    first();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await repo.load('guest'))?.name).toBe('First');
    expect(store.doc().name).toBe('Second');
    expect(session.status()).toBe('saving');
    second();
    await session.flush();
    expect((await repo.load('guest'))?.name).toBe('Second');
    expect(session.status()).toBe('saved');
  });

  describe('replacing an attachment', () => {
    const png = (bytes: number) => new File([new Uint8Array(bytes)], 'photo.png', { type: 'image/png' });
    const webp = (bytes: number) => new File([new Uint8Array(bytes)], 'photo.webp', { type: 'image/webp' });
    const currentFiles = () => store.doc().nodes['node']!.attachments;

    async function attachOriginal(): Promise<{ id: string }> {
      expect(await session.attach('node', png(4000))).toEqual({ ok: true });
      store.sealHistory();
      return currentFiles()![0]!;
    }

    it('swaps a file for its optimised version in a single undoable step', async () => {
      const original = await attachOriginal();
      expect(await session.replaceAttachment('node', original.id, webp(900))).toEqual({ ok: true });
      const [replacement] = currentFiles()!;
      expect(currentFiles()).toHaveLength(1);
      expect(replacement).toMatchObject({ name: 'photo.webp', mime: 'image/webp', size: 900 });
      expect(replacement!.id).not.toBe(original.id);
      expect((await session.getAttachment(replacement!.id))?.size).toBe(900);

      store.undo();
      expect(currentFiles()).toHaveLength(1);
      expect(currentFiles()![0]!.id).toBe(original.id);
      expect((await session.getAttachment(original.id))?.size).toBe(4000);
    });

    it('is allowed at the one-file limit yet still enforces the size limit and keeps the original on failure', async () => {
      const original = await attachOriginal();
      expect(await session.replaceAttachment('node', original.id, new File([new Uint8Array(5_242_881)], 'big.png', { type: 'image/png' })))
        .toEqual({ ok: false, reason: '“big.png” is larger than the 5 MiB limit.' });
      expect(currentFiles()!.map((a) => a.id)).toEqual([original.id]);
      expect(await repo.listAttachmentIds('guest')).toEqual([original.id]);
    });

    it('refuses an unknown attachment and a read-only board', async () => {
      const original = await attachOriginal();
      expect(await session.replaceAttachment('node', 'missing', webp(10))).toMatchObject({ ok: false });
      store.readOnly.set(true);
      expect(await session.replaceAttachment('node', original.id, webp(10))).toMatchObject({ ok: false });
      expect(currentFiles()!.map((a) => a.id)).toEqual([original.id]);
    });

    it('discards the new bytes when the original was removed while it was being stored', async () => {
      const original = await attachOriginal();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const put = repo.putAttachment.bind(repo);
      jest.spyOn(repo, 'putAttachment').mockImplementation(async (...args) => { await gate; await put(...args); });
      const replacing = session.replaceAttachment('node', original.id, webp(900));
      store.mutate((doc) => removeAttachment(doc, 'node', original.id), { label: 'Remove attachment' });
      release();
      expect(await replacing).toMatchObject({ ok: false });
      expect(currentFiles()).toBeUndefined();
      expect(await repo.listAttachmentIds('guest')).toEqual([original.id]);
    });
  });
});
