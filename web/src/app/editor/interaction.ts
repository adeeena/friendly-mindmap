import { NodeId, Camera } from '../core/model';
import { descendantsOf, topLevel } from '../core/commands';
import { Point, Rect } from '../layout/layout';
import { panBy, screenToWorld, zoomAt } from './camera';
import { EditorStore, DropTarget, EdgeRef, newTxn } from './editor-store';
import { isFullyEnclosed, rectFromPoints, smartGuides, snapValue } from './geometry';

export interface PointerInfo {
  pointerId: number;
  pointerType: string;
  button: number;
  screen: Point;
  shift: boolean;
  alt: boolean;
  /** node under the pointer (from DOM hit testing) */
  nodeId?: NodeId | null;
  edge?: EdgeRef | null;
}

type State =
  | { kind: 'idle' }
  | { kind: 'panning'; start: Point; cam: Camera }
  | { kind: 'pointing'; nodeId: NodeId; start: Point; shift: boolean; wasSelected: boolean }
  | { kind: 'dragFree'; ids: NodeId[]; anchor: NodeId; start: Point; origin: Map<NodeId, Point>; txn: string }
  | { kind: 'dragStruct'; id: NodeId; start: Point; dwell?: { id: NodeId; since: number } }
  | { kind: 'dragRoot'; id: NodeId; start: Point; origin: Point; txn: string }
  | { kind: 'brushing'; start: Point; additive: boolean; base: Set<NodeId> }
  | { kind: 'connecting'; from: NodeId }
  | { kind: 'pinching'; startDist: number; startMid: Point; cam: Camera };

export const DRAG_THRESHOLD = 3;
export const GUIDE_THRESHOLD_PX = 4;
export const DWELL_MS = 400;

/**
 * Tool state machine. The viewport feeds pointer events; this decides what
 * they mean for the active tool and mutates the store.
 */
export class InteractionController {
  state: State = { kind: 'idle' };
  private readonly pointers = new Map<number, Point>();
  /** Space held or middle mouse: temporary hand. */
  spaceHeld = false;

  constructor(
    private readonly store: EditorStore,
    private readonly now: () => number = () => performance.now(),
  ) {}

  private world(p: Point): Point {
    return screenToWorld(this.store.camera(), p);
  }

  get effectiveTool() {
    return this.spaceHeld ? 'hand' : this.store.tool();
  }

  get isPanning(): boolean {
    return this.state.kind === 'panning' || this.state.kind === 'pinching';
  }

  pointerDown(e: PointerInfo): void {
    this.pointers.set(e.pointerId, e.screen);
    if (e.pointerType === 'touch' && this.pointers.size === 2) {
      this.cancel();
      this.startPinch();
      return;
    }
    if (this.pointers.size > 1) return;

    const s = this.store;
    if (e.button === 1 || this.effectiveTool === 'hand') {
      this.state = { kind: 'panning', start: e.screen, cam: s.camera() };
      s.gesture.set(true);
      return;
    }
    if (e.button !== 0) return;
    const tool = this.effectiveTool;
    if (tool === 'node') {
      s.createRootAt(this.world(e.screen), { shape: s.newNodeShape(), kind: s.newNodeKind() });
      s.setTool('pointer');
      return;
    }
    if (tool === 'connect') {
      if (e.nodeId) {
        this.state = { kind: 'connecting', from: e.nodeId };
        s.connectPreview.set({ from: e.nodeId, to: this.world(e.screen) });
      }
      return;
    }
    // pointer tool
    if (e.edge && !e.nodeId) {
      s.selectEdge(e.edge);
      return;
    }
    if (e.nodeId) {
      if (s.editingId() && s.editingId() !== e.nodeId) s.endEdit();
      const wasSelected = s.selection().has(e.nodeId);
      if (!e.shift && !wasSelected) s.select([e.nodeId]);
      this.state = { kind: 'pointing', nodeId: e.nodeId, start: e.screen, shift: e.shift, wasSelected };
      return;
    }
    s.endEdit();
    const base = e.shift ? new Set(s.selection()) : new Set<NodeId>();
    if (!e.shift) s.clearSelection();
    this.state = { kind: 'brushing', start: this.world(e.screen), additive: e.shift, base };
  }

  pointerMove(e: PointerInfo): void {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, e.screen);
    const s = this.store;
    const st = this.state;
    switch (st.kind) {
      case 'pinching':
        this.updatePinch();
        return;
      case 'panning':
        s.camera.set(panBy(st.cam, e.screen.x - st.start.x, e.screen.y - st.start.y));
        return;
      case 'connecting':
        s.connectPreview.set({ from: st.from, to: this.world(e.screen) });
        return;
      case 'brushing': {
        const rect = rectFromPoints(st.start, this.world(e.screen));
        s.marquee.set(rect);
        const hits = [...s.rects()].filter(([, r]) => isFullyEnclosed(r, rect)).map(([id]) => id);
        s.selection.set(new Set([...st.base, ...hits]));
        return;
      }
      case 'pointing': {
        if (Math.hypot(e.screen.x - st.start.x, e.screen.y - st.start.y) < DRAG_THRESHOLD) return;
        if (s.readOnly()) return;
        this.startDrag(st.nodeId, st.start);
        this.pointerMove(e);
        return;
      }
      case 'dragFree':
        this.updateFreeDrag(st, e);
        return;
      case 'dragRoot': {
        const z = s.camera().zoom;
        let x = st.origin.x + (e.screen.x - st.start.x) / z;
        let y = st.origin.y + (e.screen.y - st.start.y) / z;
        if (s.settings().snap && !e.alt) {
          x = snapValue(x);
          y = snapValue(y);
        }
        s.mutate((d) => {
          d.nodes[st.id].x = x;
          d.nodes[st.id].y = y;
        }, { txn: st.txn, label: 'Move' });
        return;
      }
      case 'dragStruct':
        this.updateStructDrag(st, e);
        return;
    }
  }

  pointerUp(e: PointerInfo): void {
    this.pointers.delete(e.pointerId);
    const s = this.store;
    const st = this.state;
    switch (st.kind) {
      case 'pinching':
        if (this.pointers.size < 2) this.finish();
        return;
      case 'connecting':
        if (e.nodeId && e.nodeId !== st.from) s.addLink(st.from, e.nodeId);
        break;
      case 'pointing':
        if (st.shift) s.toggleSelect(st.nodeId);
        else if (st.wasSelected) s.select([st.nodeId]);
        break;
      case 'dragFree':
        s.resolveDropOverlaps(st.ids, st.txn);
        s.sealHistory();
        break;
      case 'dragRoot':
        s.sealHistory();
        break;
      case 'dragStruct': {
        const target = s.dropTarget();
        if (target) s.reparent(st.id, target);
        break;
      }
    }
    this.finish();
  }

  /** Escape or pointercancel. Struct drags are abandoned; free drags are undone. */
  cancel(): boolean {
    const st = this.state;
    if (st.kind === 'idle') return false;
    if (st.kind === 'dragFree') {
      this.store.moveNodes(st.ids, st.origin, st.txn);
    }
    if (st.kind === 'dragRoot') {
      this.store.moveNodes([st.id], new Map([[st.id, st.origin]]), st.txn);
    }
    this.finish();
    return true;
  }

  private finish(): void {
    const s = this.store;
    this.state = { kind: 'idle' };
    s.marquee.set(null);
    s.guides.set([]);
    s.connectPreview.set(null);
    s.dragPreview.set(null);
    s.dropTarget.set(null);
    s.dragging.set(false);
    s.gesture.set(false);
    if (this.pointers.size === 0) this.pointers.clear();
  }

  releasePointer(pointerId: number): void {
    this.pointers.delete(pointerId);
  }

  // ---------------------------------------------------------------- drag

  private startDrag(nodeId: NodeId, start: Point): void {
    const s = this.store;
    const doc = s.doc();
    s.dragging.set(true);
    if (s.settings().autoAlign) {
      if (!doc.nodes[nodeId].parentId) {
        const r = s.rects().get(nodeId)!;
        this.state = { kind: 'dragRoot', id: nodeId, start, origin: { x: r.x, y: r.y }, txn: newTxn('drag') };
      } else {
        s.select([nodeId]);
        this.state = { kind: 'dragStruct', id: nodeId, start };
      }
      return;
    }
    const selected = topLevel(doc, s.selectedIds().length ? s.selectedIds() : [nodeId]);
    // Hidden (collapsed) descendants move too so they stay attached when expanded.
    const ids = [...new Set(selected.flatMap((id) => [id, ...descendantsOf(doc, id)]))];
    const origin = new Map(ids.map((id) => [id, { x: doc.nodes[id].x, y: doc.nodes[id].y }]));
    this.state = { kind: 'dragFree', ids, anchor: nodeId, start, origin, txn: newTxn('drag') };
  }

  private updateFreeDrag(st: Extract<State, { kind: 'dragFree' }>, e: PointerInfo): void {
    const s = this.store;
    const z = s.camera().zoom;
    let dx = (e.screen.x - st.start.x) / z;
    let dy = (e.screen.y - st.start.y) / z;
    const anchorOrigin = st.origin.get(st.anchor)!;
    const size = s.sizeOf(st.anchor);
    if (s.settings().snap && !e.alt) {
      const moving = new Set(st.ids);
      const others = [...s.rects()].filter(([id]) => !moving.has(id)).map(([, r]) => r);
      const rect: Rect = { x: anchorOrigin.x + dx, y: anchorOrigin.y + dy, ...size };
      const g = smartGuides(rect, others, GUIDE_THRESHOLD_PX / z);
      const hasX = g.lines.some((l) => l.axis === 'x');
      const hasY = g.lines.some((l) => l.axis === 'y');
      dx = hasX ? dx + g.dx : snapValue(anchorOrigin.x + dx) - anchorOrigin.x;
      dy = hasY ? dy + g.dy : snapValue(anchorOrigin.y + dy) - anchorOrigin.y;
      s.guides.set(g.lines);
    } else {
      s.guides.set([]);
    }
    const next = new Map<NodeId, Point>();
    for (const [id, p] of st.origin) next.set(id, { x: p.x + dx, y: p.y + dy });
    s.moveNodes(st.ids, next, st.txn);
  }

  private updateStructDrag(st: Extract<State, { kind: 'dragStruct' }>, e: PointerInfo): void {
    const s = this.store;
    const doc = s.doc();
    const z = s.camera().zoom;
    const dx = (e.screen.x - st.start.x) / z;
    const dy = (e.screen.y - st.start.y) / z;
    const subtree = new Set([st.id, ...descendantsOf(doc, st.id)]);
    s.dragPreview.set({ ids: [...subtree].filter((id) => s.visibleSet().has(id)), dx, dy });
    const p = this.world(e.screen);
    const vertical = s.settings().direction === 'vertical';
    let target: DropTarget | null = null;
    for (const [id, r] of s.rects()) {
      if (subtree.has(id)) continue;
      if (p.x < r.x || p.x > r.x + r.w || p.y < r.y || p.y > r.y + r.h) continue;
      const node = doc.nodes[id];
      const t = vertical ? (p.x - r.x) / r.w : (p.y - r.y) / r.h;
      if (node.parentId && (t < 0.25 || t > 0.75)) {
        const siblings = s.doc().children[node.parentId] ?? [];
        const idx = siblings.indexOf(id);
        target = { parentId: node.parentId, index: t < 0.25 ? idx : idx + 1 };
      } else {
        target = { parentId: id };
        if (node.collapsed) {
          if (st.dwell?.id !== id) st.dwell = { id, since: this.now() };
          else if (this.now() - st.dwell.since > DWELL_MS) s.toggleCollapse(id);
        }
      }
      break;
    }
    if (!target) {
      st.dwell = undefined;
      const r = s.rects().get(st.id)!;
      const at = { x: r.x + dx, y: r.y + dy };
      target = { parentId: null, at: s.settings().snap ? { x: snapValue(at.x), y: snapValue(at.y) } : at };
    }
    s.dropTarget.set(target);
  }

  // --------------------------------------------------------------- pinch

  private pinchMetrics(): { dist: number; mid: Point } {
    const [a, b] = [...this.pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  private startPinch(): void {
    const { dist, mid } = this.pinchMetrics();
    this.state = { kind: 'pinching', startDist: dist, startMid: mid, cam: this.store.camera() };
    this.store.gesture.set(true);
  }

  private updatePinch(): void {
    const st = this.state;
    if (st.kind !== 'pinching' || this.pointers.size < 2) return;
    const { dist, mid } = this.pinchMetrics();
    const zoomed = zoomAt(st.cam, st.cam.zoom * (dist / Math.max(st.startDist, 1)), st.startMid);
    this.store.camera.set(panBy(zoomed, mid.x - st.startMid.x, mid.y - st.startMid.y));
  }
}
