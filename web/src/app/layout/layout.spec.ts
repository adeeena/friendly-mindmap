import { produce } from 'immer';
import { addChild, createRoot } from '../core/commands';
import { BoardDoc, NodeId, createBoard } from '../core/model';
import {
  Rect,
  Size,
  findFreeSlot,
  layoutForest,
  layoutTree,
  nudgeOutOfOverlap,
  rectsOverlap,
} from './layout';

function tree(childCount: number, grandKids = 0): { doc: BoardDoc; root: NodeId; kids: NodeId[] } {
  let root = '';
  const kids: NodeId[] = [];
  const doc = produce(createBoard(), (d) => {
    root = createRoot(d, { x: 100, y: 200 });
    for (let i = 0; i < childCount; i++) {
      const k = addChild(d, root);
      kids.push(k);
      for (let j = 0; j < grandKids; j++) addChild(d, k);
    }
  });
  return { doc, root, kids };
}

function rects(pos: Map<NodeId, { x: number; y: number }>, sizeOf: (id: NodeId) => Size): Rect[] {
  return [...pos].map(([id, p]) => ({ ...p, ...sizeOf(id) }));
}

function assertNoOverlap(rs: Rect[]) {
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++) expect(rectsOverlap(rs[i], rs[j])).toBe(false);
}

describe('layoutTree', () => {
  it('horizontal: children right of root, ordered, no overlaps with mixed sizes', () => {
    const { doc, root, kids } = tree(3, 2);
    const sizes: Record<string, Size> = { [kids[1]]: { w: 200, h: 160 } };
    const sizeOf = (id: NodeId) => sizes[id] ?? { w: 100, h: 30 };
    const pos = layoutTree(doc, root, sizeOf, 'horizontal', { x: 100, y: 200 });
    expect(pos.get(root)).toEqual({ x: 100, y: 200 });
    for (const k of kids) expect(pos.get(k)!.x).toBeGreaterThan(100 + 100);
    expect(pos.get(kids[0])!.y).toBeLessThan(pos.get(kids[1])!.y);
    expect(pos.get(kids[1])!.y).toBeLessThan(pos.get(kids[2])!.y);
    assertNoOverlap(rects(pos, sizeOf));
  });

  it('vertical: children below root and side by side', () => {
    const { doc, root, kids } = tree(3, 1);
    const sizeOf = () => ({ w: 100, h: 30 });
    const pos = layoutTree(doc, root, sizeOf, 'vertical', { x: 0, y: 0 });
    for (const k of kids) expect(pos.get(k)!.y).toBeGreaterThan(30);
    expect(pos.get(kids[0])!.x).toBeLessThan(pos.get(kids[1])!.x);
    assertNoOverlap(rects(pos, sizeOf));
  });

  it('balanced: 4 children split 2 right / 2 left', () => {
    const { doc, root, kids } = tree(4);
    const sizeOf = () => ({ w: 100, h: 30 });
    const pos = layoutTree(doc, root, sizeOf, 'balanced', { x: 0, y: 0 });
    const right = kids.filter((k) => pos.get(k)!.x > 0);
    const left = kids.filter((k) => pos.get(k)!.x < 0);
    expect(right).toHaveLength(2);
    expect(left).toHaveLength(2);
    assertNoOverlap(rects(pos, sizeOf));
  });

  it('collapsed nodes hide their descendants', () => {
    const { doc, root, kids } = tree(2, 2);
    const collapsed = produce(doc, (d) => {
      d.nodes[kids[0]].collapsed = true;
    });
    const pos = layoutTree(collapsed, root, () => ({ w: 80, h: 30 }), 'horizontal', { x: 0, y: 0 });
    expect(pos.size).toBe(1 + 2 + 2);
  });
});

describe('layoutForest', () => {
  it('pushes a neighbouring tree out when a tree grows into it', () => {
    let a = '';
    let b = '';
    const doc = produce(createBoard(), (d) => {
      a = createRoot(d, { x: 0, y: 0 });
      for (let i = 0; i < 10; i++) addChild(d, a);
      b = createRoot(d, { x: 200, y: 40 });
    });
    const sizeOf = () => ({ w: 100, h: 30 });
    const pos = layoutForest(doc, sizeOf, 'horizontal');
    expect(pos.get(a)).toEqual({ x: 0, y: 0 });
    expect(pos.get(b)).not.toEqual({ x: 200, y: 40 });
    assertNoOverlap(rects(pos, sizeOf));
  });
});

describe('free placement', () => {
  it('finds the nearest free slot when the candidate is occupied', () => {
    const obstacle = { x: 200, y: 0, w: 100, h: 30 };
    const p = findFreeSlot({ x: 200, y: 0, w: 100, h: 30 }, [obstacle], 'horizontal');
    expect(p.x).toBe(200);
    expect(rectsOverlap({ ...p, w: 100, h: 30 }, obstacle)).toBe(false);
  });

  it('nudges a dropped node minimally', () => {
    const p = nudgeOutOfOverlap({ x: 95, y: 0, w: 100, h: 30 }, [{ x: 0, y: 0, w: 100, h: 30 }], 8);
    expect(p).toEqual({ x: 108, y: 0 });
  });
});
