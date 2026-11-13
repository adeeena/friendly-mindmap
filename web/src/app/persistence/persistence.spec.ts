/**
 * @jest-environment node
 */
import 'fake-indexeddb/auto';
import { ROOT_KEY, SCHEMA_VERSION, createBoard, createNode } from '../core/model';
import { AttachmentPolicyError, BoardRecord, MemoryBoardRepository, RevisionConflictError } from './board-repository';
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
    const result = await repo.save(record('a'), null);
    expect(result.revision).toBe(1);
    expect(result.cloud).toEqual({ status: 'not-applicable' });
    expect(result.localDurability).toBe(_name === 'memory' ? 'memory' : 'persistent');
    expect(repo.workspace).toEqual({ kind: 'guest' });
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
    await expect(repo.save(record('a'), null)).rejects.toBeInstanceOf(RevisionConflictError);
    await expect(repo.save(record('a'), 99)).rejects.toBeInstanceOf(RevisionConflictError);
    await repo.delete('a');
    await expect(repo.save(record('a'), 2)).rejects.toBeInstanceOf(RevisionConflictError);
  });

  it('stores, lists and deletes attachments with the board', async () => {
    const repo = make();
    await repo.save(record('a'), null);
    const meta = { id: 'f1', name: 'x.txt', mime: 'text/plain', size: 3 };
    await repo.putAttachment('a', meta, new Blob(['abc'], { type: 'text/plain' }), { nodeId: 'n', attachments: [] });
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

  it('requires node context and actual-byte metadata and enforces exact guest limits', async () => {
    const repo = make();
    const meta = { id: 'f', name: 'file.bin', mime: 'application/octet-stream', size: 5_242_880 };
    const blob = new Blob([new Uint8Array(meta.size)]);
    await repo.putAttachment('a', meta, blob, { nodeId: 'node', attachments: [] });
    expect((await repo.getAttachment('a', meta.id))?.size).toBe(meta.size);
    await expect(repo.putAttachment('a', { ...meta, id: 'large', size: meta.size + 1 },
      new Blob([new Uint8Array(meta.size + 1)]), { nodeId: 'node', attachments: [] })).rejects.toMatchObject({ violation: 'size' });
    await expect(repo.putAttachment('a', { ...meta, id: 'second' }, blob,
      { nodeId: 'node', attachments: [meta] })).rejects.toMatchObject({ violation: 'count' });
    await expect(repo.putAttachment('a', { ...meta, size: 1 }, blob,
      { nodeId: 'node', attachments: [] })).rejects.toBeInstanceOf(AttachmentPolicyError);
  });
});

it('keeps legacy over-limit IndexedDB bytes readable and removable without migrating guest data', async () => {
  const { openDB } = await import('idb');
  const name = 'legacy-' + Math.random();
  const repo = new IndexedDbBoardRepository(name);
  await repo.save(record('legacy'), null);
  const db = await openDB(name);
  const meta = { id: 'large', name: 'legacy.bin', mime: 'application/octet-stream', size: 10 * 1024 * 1024 };
  await db.put('attachments', { boardId: 'legacy', id: meta.id, meta, data: new Uint8Array(meta.size).buffer });
  expect(db.version).toBe(1);
  expect((await repo.getAttachment('legacy', meta.id))?.size).toBe(meta.size);
  await repo.deleteAttachment('legacy', meta.id);
  expect(await repo.getAttachment('legacy', meta.id)).toBeNull();
  db.close();
});

describe('migrations', () => {
  it('passes current version through with validation', () => {
    const b = migrateBoard({ ...record('a'), revision: 3 });
    expect(b.schemaVersion).toBe(SCHEMA_VERSION);
    expect(b.revision).toBe(3);
    expect(b.doc.id).toBe('a');
  });

  it('loads a v1 board with no offsets or edge styles', () => {
    const doc = createBoard('Old', 'old');
    doc.nodes['r'] = createNode({ id: 'r' });
    doc.nodes['c'] = createNode({ id: 'c', parentId: 'r', x: 40, y: 8 });
    doc.children[ROOT_KEY] = ['r'];
    doc.children['r'] = ['c'];
    const b = migrateBoard({ schemaVersion: 1, doc, camera: { x: 0, y: 0, zoom: 1 } });
    expect(b.schemaVersion).toBe(SCHEMA_VERSION);
    expect(b.doc.nodes['c'].parentId).toBe('r');
    expect(b.doc.nodes['c'].x).toBe(40);
    expect(b.doc.nodes['c'].layoutOffset).toBeUndefined();
    expect(b.doc.nodes['c'].edgeStyle).toBeUndefined();
  });

  it('keeps valid offsets and edge styles and drops invalid ones', () => {
    const doc = createBoard('New', 'new');
    doc.nodes['r'] = createNode({ id: 'r' });
    doc.nodes['c'] = createNode({
      id: 'c',
      parentId: 'r',
      layoutOffset: { x: 10, y: -5 },
      edgeStyle: { pattern: 'dashed', color: 'red', width: 4 },
    });
    doc.nodes['d'] = createNode({ id: 'd', parentId: 'r' });
    (doc.nodes['d'] as unknown as Record<string, unknown>)['edgeStyle'] = { pattern: 'wavy', color: 'nope', width: 'x' };
    doc.children[ROOT_KEY] = ['r'];
    doc.children['r'] = ['c', 'd'];
    doc.links['l'] = { id: 'l', from: 'c', to: 'd', edgeStyle: { pattern: 'dotted' } };
    const b = migrateBoard({ schemaVersion: SCHEMA_VERSION, doc, camera: { x: 0, y: 0, zoom: 1 } });
    expect(b.doc.nodes['c'].layoutOffset).toEqual({ x: 10, y: -5 });
    expect(b.doc.nodes['c'].edgeStyle).toEqual({ pattern: 'dashed', color: 'red', width: 4 });
    expect(b.doc.nodes['d'].edgeStyle).toBeUndefined();
    expect(b.doc.links['l'].edgeStyle).toEqual({ pattern: 'dotted' });
  });

  it('accepts palette and older color keys for nodes, tags and edges, and drops unknown ones', () => {
    const doc = createBoard('Colors', 'colors');
    doc.nodes['r'] = createNode({ id: 'r', color: 'rose' });
    doc.nodes['a'] = createNode({ id: 'a', parentId: 'r', color: 'green', edgeStyle: { color: 'navy' } });
    doc.nodes['b'] = createNode({ id: 'b', parentId: 'r' });
    (doc.nodes['b'] as unknown as Record<string, unknown>)['color'] = 'chartreuse';
    doc.tags['t'] = { id: 't', name: 'work', color: 'mint' };
    doc.tags['old'] = { id: 'old', name: 'legacy', color: 'slate' };
    doc.children[ROOT_KEY] = ['r'];
    doc.children['r'] = ['a', 'b'];
    const b = migrateBoard({ schemaVersion: SCHEMA_VERSION, doc, camera: { x: 0, y: 0, zoom: 1 } });
    expect(b.doc.nodes['r'].color).toBe('rose');
    expect(b.doc.nodes['a'].color).toBe('green');
    expect(b.doc.nodes['a'].edgeStyle?.color).toBe('navy');
    expect(b.doc.nodes['b'].color).toBeUndefined();
    expect(b.doc.tags['t'].color).toBe('mint');
    expect(b.doc.tags['old'].color).toBe('slate');
  });

  it('refuses newer versions', () => {
    expect(() => migrateBoard({ ...record('a'), schemaVersion: SCHEMA_VERSION + 1 })).toThrow(NewerSchemaError);
  });

  it('runs ordered migration steps', () => {
    const steps = { 1: (r: Record<string, unknown>) => ({ ...r, camera: { x: 5, y: 0, zoom: 1 } }) };
    const b = migrateBoard({ ...record('a'), schemaVersion: 1 }, steps, 2);
    expect(b.camera.x).toBe(5);
    expect(Object.keys(MIGRATIONS)).toEqual(['1']);
  });
});
