import { childrenOf } from '../core/commands';
import { BoardDoc, LayoutDirection, NodeId } from '../core/model';

export interface Size {
  w: number;
  h: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface Rect extends Point, Size {}

export const DEFAULT_SIZE: Size = { w: 120, h: 40 };

export interface Spacing {
  level: number;
  sibling: number;
  tree: number;
}

export function spacingFor(direction: LayoutDirection): Spacing {
  return direction === 'vertical'
    ? { level: 48, sibling: 24, tree: 48 }
    : { level: 56, sibling: 16, tree: 48 };
}

export type SizeOf = (id: NodeId) => Size;

/** Children that participate in layout (hidden when the parent is collapsed). */
export function visibleChildren(doc: BoardDoc, id: NodeId): NodeId[] {
  return doc.nodes[id]?.collapsed ? [] : childrenOf(doc, id);
}

export function visibleNodeIds(doc: BoardDoc): NodeId[] {
  const out: NodeId[] = [];
  const visit = (id: NodeId) => {
    out.push(id);
    for (const c of visibleChildren(doc, id)) visit(c);
  };
  childrenOf(doc, null).forEach(visit);
  return out;
}

interface Axis {
  /** size along the depth axis */
  depth: (s: Size) => number;
  /** size along the breadth axis */
  breadth: (s: Size) => number;
  toPoint: (depth: number, breadth: number) => Point;
}

const HORIZONTAL: Axis = {
  depth: (s) => s.w,
  breadth: (s) => s.h,
  toPoint: (d, b) => ({ x: d, y: b }),
};
const VERTICAL: Axis = {
  depth: (s) => s.h,
  breadth: (s) => s.w,
  toPoint: (d, b) => ({ x: b, y: d }),
};

/**
 * Lays out one subtree with box stacking. Coordinates are relative: the root's
 * top-left is at depth 0 and breadth 0. `sign` = -1 grows toward negative depth.
 */
function layoutSubtree(
  doc: BoardDoc,
  rootId: NodeId,
  rootChildren: NodeId[],
  sizeOf: SizeOf,
  axis: Axis,
  sp: Spacing,
  sign: 1 | -1,
  out: Map<NodeId, { depth: number; breadth: number }>,
): void {
  const breadthCache = new Map<NodeId, number>();
  const kids = (id: NodeId) => (id === rootId ? rootChildren : visibleChildren(doc, id));
  const subtreeBreadth = (id: NodeId): number => {
    const cached = breadthCache.get(id);
    if (cached !== undefined) return cached;
    const k = kids(id);
    const block = k.reduce((sum, c) => sum + subtreeBreadth(c), 0) + sp.sibling * Math.max(0, k.length - 1);
    const b = Math.max(axis.breadth(sizeOf(id)), block);
    breadthCache.set(id, b);
    return b;
  };
  const rootSize = sizeOf(rootId);
  const rootB = axis.breadth(rootSize);

  // Center of the root on the breadth axis is the reference line (rootB / 2).
  const place = (id: NodeId, depthStart: number, centerB: number) => {
    const s = sizeOf(id);
    const d = sign === 1 ? depthStart : depthStart - axis.depth(s);
    out.set(id, { depth: d, breadth: centerB - axis.breadth(s) / 2 });
    const k = kids(id);
    if (!k.length) return;
    const nextDepth = sign === 1 ? d + axis.depth(s) + sp.level : d - sp.level;
    const block = k.reduce((sum, c) => sum + subtreeBreadth(c), 0) + sp.sibling * (k.length - 1);
    let cursor = centerB - block / 2;
    for (const c of k) {
      const cb = subtreeBreadth(c);
      place(c, nextDepth, cursor + cb / 2);
      cursor += cb + sp.sibling;
    }
  };

  // Root itself is placed by the caller; only lay out its children.
  const k = rootChildren;
  if (!k.length) return;
  const nextDepth = sign === 1 ? axis.depth(rootSize) + sp.level : -sp.level;
  const block = k.reduce((sum, c) => sum + subtreeBreadth(c), 0) + sp.sibling * (k.length - 1);
  let cursor = rootB / 2 - block / 2;
  for (const c of k) {
    const cb = subtreeBreadth(c);
    place(c, nextDepth, cursor + cb / 2);
    cursor += cb + sp.sibling;
  }
}

/** Splits root children into [right, left] groups of roughly equal breadth. */
export function balanceSplit(
  doc: BoardDoc,
  children: NodeId[],
  sizeOf: SizeOf,
  sp: Spacing,
): [NodeId[], NodeId[]] {
  const breadth = (id: NodeId): number => {
    const k = visibleChildren(doc, id);
    const block = k.reduce((s, c) => s + breadth(c), 0) + sp.sibling * Math.max(0, k.length - 1);
    return Math.max(sizeOf(id).h, block);
  };
  const weights = children.map(breadth);
  const total = weights.reduce((a, b) => a + b, 0);
  const right: NodeId[] = [];
  let sum = 0;
  let i = 0;
  while (i < children.length && sum < total / 2) {
    right.push(children[i]);
    sum += weights[i];
    i++;
  }
  return [right, children.slice(i)];
}

/** Positions (top-left) of every visible node in one tree, root kept at `origin`. */
export function layoutTree(
  doc: BoardDoc,
  rootId: NodeId,
  sizeOf: SizeOf,
  direction: LayoutDirection,
  origin: Point,
): Map<NodeId, Point> {
  const sp = spacingFor(direction);
  const rel = new Map<NodeId, { depth: number; breadth: number }>();
  const children = visibleChildren(doc, rootId);
  const axis = direction === 'vertical' ? VERTICAL : HORIZONTAL;
  if (direction === 'balanced') {
    const [right, left] = balanceSplit(doc, children, sizeOf, sp);
    layoutSubtree(doc, rootId, right, sizeOf, axis, sp, 1, rel);
    layoutSubtree(doc, rootId, left, sizeOf, axis, sp, -1, rel);
  } else {
    layoutSubtree(doc, rootId, children, sizeOf, axis, sp, 1, rel);
  }
  const out = new Map<NodeId, Point>();
  out.set(rootId, { ...origin });
  for (const [id, r] of rel) {
    const p = axis.toPoint(r.depth, r.breadth);
    out.set(id, { x: origin.x + p.x, y: origin.y + p.y });
  }
  return out;
}

export function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  return (
    a.x < b.x + b.w + margin &&
    b.x < a.x + a.w + margin &&
    a.y < b.y + b.h + margin &&
    b.y < a.y + a.h + margin
  );
}

export function boundsOf(rects: Iterable<Rect>): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Minimal translation that moves `a` out of `b` (with margin). */
export function separation(a: Rect, b: Rect, margin: number): Point {
  const right = b.x + b.w + margin - a.x;
  const left = a.x + a.w + margin - b.x;
  const down = b.y + b.h + margin - a.y;
  const up = a.y + a.h + margin - b.y;
  const options: Point[] = [
    { x: right, y: 0 },
    { x: -left, y: 0 },
    { x: 0, y: down },
    { x: 0, y: -up },
  ];
  return options.reduce((best, o) => (Math.abs(o.x) + Math.abs(o.y) < Math.abs(best.x) + Math.abs(best.y) ? o : best));
}

/**
 * Lays out every tree and shifts later trees so tree bounds never overlap.
 * Returns top-left positions of visible nodes.
 */
export function layoutForest(doc: BoardDoc, sizeOf: SizeOf, direction: LayoutDirection): Map<NodeId, Point> {
  const sp = spacingFor(direction);
  const result = new Map<NodeId, Point>();
  const placed: Rect[] = [];
  for (const rootId of childrenOf(doc, null)) {
    const root = doc.nodes[rootId];
    const tree = layoutTree(doc, rootId, sizeOf, direction, { x: root.x, y: root.y });
    const rectOf = (shift: Point) =>
      boundsOf([...tree].map(([id, p]) => ({ x: p.x + shift.x, y: p.y + shift.y, ...sizeOf(id) })))!;
    const shift = { x: 0, y: 0 };
    for (let iter = 0; iter < 20; iter++) {
      const r = rectOf(shift);
      const hit = placed.find((p) => rectsOverlap(r, p, sp.tree));
      if (!hit) break;
      const s = separation(r, hit, sp.tree);
      shift.x += s.x;
      shift.y += s.y;
    }
    placed.push(rectOf(shift));
    for (const [id, p] of tree) result.set(id, { x: p.x + shift.x, y: p.y + shift.y });
  }
  return result;
}

/**
 * Searches outward along the breadth axis from `candidate` for a spot that does
 * not overlap any obstacle.
 */
export function findFreeSlot(
  candidate: Rect,
  obstacles: Rect[],
  direction: LayoutDirection,
  margin = 12,
): Point {
  const step = direction === 'vertical' ? candidate.w / 2 + margin : candidate.h / 2 + margin;
  for (let i = 0; i < 400; i++) {
    const k = i === 0 ? 0 : Math.ceil(i / 2) * (i % 2 === 1 ? 1 : -1);
    const r =
      direction === 'vertical'
        ? { ...candidate, x: candidate.x + k * step }
        : { ...candidate, y: candidate.y + k * step };
    if (!obstacles.some((o) => rectsOverlap(r, o, margin))) return { x: r.x, y: r.y };
  }
  return { x: candidate.x, y: candidate.y };
}

/** Moves `rect` the minimal distance so it no longer overlaps obstacles. */
export function nudgeOutOfOverlap(rect: Rect, obstacles: Rect[], margin = 8): Point {
  const r = { ...rect };
  for (let iter = 0; iter < 30; iter++) {
    const hit = obstacles.find((o) => rectsOverlap(r, o, margin));
    if (!hit) break;
    const s = separation(r, hit, margin);
    r.x += s.x;
    r.y += s.y;
  }
  return { x: r.x, y: r.y };
}
