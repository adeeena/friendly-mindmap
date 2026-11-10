/**
 * @jest-environment node
 */
import 'fake-indexeddb/auto';
import { SCHEMA_VERSION, createBoard } from '../core/model';
import { BoardRecord, MemoryBoardRepository, RevisionConflictError } from './board-repository';
import { IndexedDbBoardRepository } from './indexeddb-repository';
import { MIGRATIONS, NewerSchemaError, migrateBoard } from './migrations';

function record(id: string, name = 'B'): Omit<BoardRecord, 'revision'> {
  const doc = createBoard(name, id);
  return { id, name, schemaVersion: SCHEMA_VERSION, updatedAt: Date.now(), doc, camera: { x: 0, y: 0, zoom: 1 } };
}

describe.each([
  ['IndexedDB', () => new IndexedDbBoardRepository('test-' + Math.random())],
  ['memory', () => new MemoryBoardRepository()],
])('%s repository', (_name, make) => {
  it('increments revision on each save and lists boards', async () => {
    const repo = make();
    expect((await repo.save(record('a'), null)).revision).toBe(1);
    expect((await repo.save(record('a'), 1)).revision).toBe(2);
    await repo.save(record('b', 'Other'), null);
    expect((await repo.load('a'))?.revision).toBe(2);
    expect((await repo.list()).map((b) => b.id).sort()).toEqual(['a', 'b']);
  });

  it('rejects stale writes', async () => {
    const repo = make();
    await repo.save(record('a'), null);
    await repo.save(record('a'), 1);
    await expect(repo.save(record('a'), 1)).rejects.toBeInstanceOf(RevisionConflictError);
  });

  it('stores, lists and deletes attachments with the board', async () => {
    const repo = make();
    await repo.save(record('a'), null);
    const meta = { id: 'f1', name: 'x.txt', mime: 'text/plain', size: 3 };
    await repo.putAttachment('a', meta, new Blob(['abc'], { type: 'text/plain' }));
    expect(await repo.listAttachmentIds('a')).toEqual(['f1']);
    const blob = await repo.getAttachment('a', 'f1');
    expect(await blob?.text()).toBe('abc');
    await repo.delete('a');
    expect(await repo.load('a')).toBeNull();
    expect(await repo.listAttachmentIds('a')).toEqual([]);
  });

  it('stores meta values', async () => {
    const repo = make();
    await repo.setMeta('lastBoard', 'a');
    expect(await repo.getMeta('lastBoard')).toBe('a');
  });
});

describe('migrations', () => {
  it('passes v1 through with validation', () => {
    const b = migrateBoard({ ...record('a'), revision: 3 });
    expect(b.schemaVersion).toBe(SCHEMA_VERSION);
    expect(b.revision).toBe(3);
    expect(b.doc.id).toBe('a');
  });

  it('refuses newer versions', () => {
    expect(() => migrateBoard({ ...record('a'), schemaVersion: SCHEMA_VERSION + 1 })).toThrow(NewerSchemaError);
  });

  it('runs ordered migration steps', () => {
    const steps = { 1: (r: Record<string, unknown>) => ({ ...r, camera: { x: 5, y: 0, zoom: 1 } }) };
    const b = migrateBoard({ ...record('a'), schemaVersion: 1 }, steps, 2);
    expect(b.camera.x).toBe(5);
    expect(MIGRATIONS).toEqual({});
  });
});
