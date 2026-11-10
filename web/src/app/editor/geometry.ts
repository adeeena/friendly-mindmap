import { GRID_SIZE, LayoutDirection } from '../core/model';
import { Point, Rect } from '../layout/layout';

export const snapValue = (v: number, grid = GRID_SIZE) => Math.round(v / grid) * grid;

export function isFullyEnclosed(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export function rectFromPoints(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export interface GuideLine {
  axis: 'x' | 'y';
  /** world coordinate of the line on its axis */
  pos: number;
  from: number;
  to: number;
}

export interface GuideResult {
  dx: number;
  dy: number;
  lines: GuideLine[];
}

/**
 * Finds the closest edge/center alignment of `moving` with `others` within
 * `threshold` (world units) on each axis.
 */
export function smartGuides(moving: Rect, others: Rect[], threshold: number): GuideResult {
  const xs = (r: Rect) => [r.x, r.x + r.w / 2, r.x + r.w];
  const ys = (r: Rect) => [r.y, r.y + r.h / 2, r.y + r.h];
  let bestX: { d: number; pos: number; other: Rect } | null = null;
  let bestY: { d: number; pos: number; other: Rect } | null = null;
  for (const o of others) {
    for (const mv of xs(moving))
      for (const ov of xs(o)) {
        const d = ov - mv;
        if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, pos: ov, other: o };
      }
    for (const mv of ys(moving))
      for (const ov of ys(o)) {
        const d = ov - mv;
        if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, pos: ov, other: o };
      }
  }
  const lines: GuideLine[] = [];
  const dx = bestX?.d ?? 0;
  const dy = bestY?.d ?? 0;
  if (bestX) {
    const top = Math.min(moving.y + dy, bestX.other.y);
    const bottom = Math.max(moving.y + dy + moving.h, bestX.other.y + bestX.other.h);
    lines.push({ axis: 'x', pos: bestX.pos, from: top, to: bottom });
  }
  if (bestY) {
    const left = Math.min(moving.x + dx, bestY.other.x);
    const right = Math.max(moving.x + dx + moving.w, bestY.other.x + bestY.other.w);
    lines.push({ axis: 'y', pos: bestY.pos, from: left, to: right });
  }
  return { dx, dy, lines };
}

export const center = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

type Side = 'left' | 'right' | 'top' | 'bottom';

function anchor(r: Rect, side: Side): Point {
  switch (side) {
    case 'left':
      return { x: r.x, y: r.y + r.h / 2 };
    case 'right':
      return { x: r.x + r.w, y: r.y + r.h / 2 };
    case 'top':
      return { x: r.x + r.w / 2, y: r.y };
    case 'bottom':
      return { x: r.x + r.w / 2, y: r.y + r.h };
  }
}

const NORMAL: Record<Side, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

const f = (n: number) => Math.round(n * 10) / 10;

export interface EdgeGeometry {
  /** stroked centerline */
  d: string;
  /** path used for hit testing */
  center: string;
  start: Point;
  end: Point;
}

/** S-curve from parent to child along the layout axis. */
export function hierarchyEdge(parent: Rect, child: Rect, direction: LayoutDirection): EdgeGeometry {
  const pc = center(parent);
  const cc = center(child);
  let ps: Side;
  let cs: Side;
  if (direction === 'vertical') {
    const down = cc.y >= pc.y;
    ps = down ? 'bottom' : 'top';
    cs = down ? 'top' : 'bottom';
  } else {
    const right = cc.x >= pc.x;
    ps = right ? 'right' : 'left';
    cs = right ? 'left' : 'right';
  }
  const p0 = anchor(parent, ps);
  const p3 = anchor(child, cs);
  const horizontal = direction !== 'vertical';
  const dist = horizontal ? Math.abs(p3.x - p0.x) : Math.abs(p3.y - p0.y);
  const k = Math.max(dist * 0.5, 16);
  const n0 = NORMAL[ps];
  const n3 = NORMAL[cs];
  const p1 = { x: p0.x + n0.x * k, y: p0.y + n0.y * k };
  const p2 = { x: p3.x + n3.x * k, y: p3.y + n3.y * k };
  const d = `M${f(p0.x)},${f(p0.y)} C${f(p1.x)},${f(p1.y)} ${f(p2.x)},${f(p2.y)} ${f(p3.x)},${f(p3.y)}`;
  return { d, center: d, start: p0, end: p3 };
}

/** Curved cross-link between the facing sides of two nodes. */
export function linkEdge(from: Rect, to: Rect): EdgeGeometry {
  const a = center(from);
  const b = center(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let fs: Side;
  let ts: Side;
  if (Math.abs(dx) >= Math.abs(dy)) {
    fs = dx >= 0 ? 'right' : 'left';
    ts = dx >= 0 ? 'left' : 'right';
  } else {
    fs = dy >= 0 ? 'bottom' : 'top';
    ts = dy >= 0 ? 'top' : 'bottom';
  }
  const p0 = anchor(from, fs);
  const p3 = anchor(to, ts);
  const k = Math.max(Math.hypot(p3.x - p0.x, p3.y - p0.y) * 0.4, 24);
  const p1 = { x: p0.x + NORMAL[fs].x * k, y: p0.y + NORMAL[fs].y * k };
  const p2 = { x: p3.x + NORMAL[ts].x * k, y: p3.y + NORMAL[ts].y * k };
  const d = `M${f(p0.x)},${f(p0.y)} C${f(p1.x)},${f(p1.y)} ${f(p2.x)},${f(p2.y)} ${f(p3.x)},${f(p3.y)}`;
  return { d, center: d, start: p0, end: p3 };
}

/** Straight-ish preview curve from a node to a free point (connect tool). */
export function previewEdge(from: Rect, to: Point): string {
  const a = center(from);
  return `M${f(a.x)},${f(a.y)} L${f(to.x)},${f(to.y)}`;
}
