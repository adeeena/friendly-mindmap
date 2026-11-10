import { Injectable, computed, inject, signal } from '@angular/core';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { Draft } from 'immer';
import * as cmd from '../core/commands';
import { History } from '../core/history';
import { ResolvedStyle, resolveStyles } from '../core/inheritance';
import {
  BoardDoc,
  BoardSettings,
  Camera,
  ColorKey,
  MindNode,
  NodeId,
  ROOT_KEY,
  RichDoc,
  Shape,
  StoredBoard,
  createBoard,
  textDoc,
} from '../core/model';
import { richToPlain } from '../core/rich-text';
import {
  DEFAULT_SIZE,
  Point,
  Rect,
  Size,
  boundsOf,
  findFreeSlot,
  layoutForest,
  nudgeOutOfOverlap,
  spacingFor,
  visibleNodeIds,
} from '../layout/layout';
import { GuideLine, snapValue } from './geometry';
import { centerOn, fitBounds, zoomAt } from './camera';

export type ToolId = 'pointer' | 'hand' | 'node' | 'connect';
export type EdgeRef = { type: 'hierarchy'; childId: NodeId } | { type: 'link'; id: string };

export interface DropTarget {
  parentId: NodeId | null;
  index?: number;
  /** world point for a new root */
  at?: Point;
}

let txnCounter = 0;
export const newTxn = (prefix: string) => `${prefix}-${++txnCounter}`;

@Injectable({ providedIn: 'root' })
export class EditorStore {
  private readonly announcer = inject(LiveAnnouncer);
  private history = new History<BoardDoc>();

  // ---- document (persisted, undoable) ----
  readonly doc = signal<BoardDoc>(createBoard());
  /** Increments on every document change; drives autosave. */
  readonly docVersion = signal(0);
  readonly canUndo = signal(false);
  readonly canRedo = signal(false);
  readonly readOnly = signal(false);

  // ---- view state (not undoable) ----
  readonly camera = signal<Camera>({ x: 0, y: 0, zoom: 1 });
  readonly viewport = signal<Size>({ w: 1024, h: 768 });
  readonly selection = signal<ReadonlySet<NodeId>>(new Set());
  readonly selectedEdge = signal<EdgeRef | null>(null);
  readonly editingId = signal<NodeId | null>(null);
  /** First character typed to start editing (replaces the text). */
  readonly editSeed = signal<string | null>(null);
  /** Increments per editing session so editors remount even if editing restarts within one tick. */
  readonly editSession = signal(0);
  /** Keys typed after editing started but before an editor took focus (chars or 'Tab', 'Shift+Tab', 'Enter', 'Escape'). */
  readonly typeAhead: string[] = [];
  /** Set by the mounted node editor to consume `typeAhead`. */
  drainTypeAhead: (() => void) | null = null;
  /** True while buffered keys are being replayed (they may start new edits). */
  replaying = false;
  readonly tool = signal<ToolId>('pointer');
  readonly newNodeShape = signal<Shape>('rounded');
  readonly newNodeKind = signal<MindNode['kind']>('topic');
  readonly tagFilter = signal<readonly string[]>([]);
  readonly sizes = signal<Record<NodeId, Size>>({});
  readonly gesture = signal(false);
  readonly dragging = signal(false);
  readonly dragPreview = signal<{ ids: NodeId[]; dx: number; dy: number } | null>(null);
  readonly dropTarget = signal<DropTarget | null>(null);
  readonly notesOpen = signal(false);
  readonly marquee = signal<Rect | null>(null);
  readonly guides = signal<GuideLine[]>([]);
  readonly connectPreview = signal<{ from: NodeId; to: Point } | null>(null);

  // ---- derived ----
  readonly settings = computed(() => this.doc().settings);
  readonly styles = computed<Record<NodeId, ResolvedStyle>>(() => resolveStyles(this.doc()));
  readonly visibleIds = computed(() => visibleNodeIds(this.doc()));
  readonly visibleSet = computed(() => new Set(this.visibleIds()));

  readonly positions = computed<Map<NodeId, Point>>(() => {
    const doc = this.doc();
    const sizes = this.sizes();
    const sizeOf = (id: NodeId) => sizes[id] ?? DEFAULT_SIZE;
    if (doc.settings.autoAlign) return layoutForest(doc, sizeOf, doc.settings.direction);
    const out = new Map<NodeId, Point>();
    for (const id of this.visibleIds()) out.set(id, { x: doc.nodes[id].x, y: doc.nodes[id].y });
    return out;
  });

  readonly rects = computed<Map<NodeId, Rect>>(() => {
    const sizes = this.sizes();
    const out = new Map<NodeId, Rect>();
    for (const [id, p] of this.positions()) out.set(id, { ...p, ...(sizes[id] ?? DEFAULT_SIZE) });
    return out;
  });

  readonly contentBounds = computed(() => boundsOf(this.rects().values()));

  /** Rects including the structural-drag ghost offset. */
  readonly displayRects = computed<Map<NodeId, Rect>>(() => {
    const preview = this.dragPreview();
    const rects = this.rects();
    if (!preview) return rects;
    const out = new Map(rects);
    for (const id of preview.ids) {
      const r = rects.get(id);
      if (r) out.set(id, { ...r, x: r.x + preview.dx, y: r.y + preview.dy });
    }
    return out;
  });

  readonly contextMenu = signal<{ x: number; y: number; nodeId: NodeId } | null>(null);

  readonly filterMatches = computed<Set<NodeId> | null>(() => {
    const filter = this.tagFilter();
    if (!filter.length) return null;
    const styles = this.styles();
    const out = new Set<NodeId>();
    for (const id of this.visibleIds()) if (styles[id]?.tags.some((t) => filter.includes(t))) out.add(id);
    return out;
  });

  readonly selectedIds = computed(() => [...this.selection()].filter((id) => this.doc().nodes[id]));
  readonly primaryId = computed(() => {
    const ids = this.selectedIds();
    return ids.length ? ids[ids.length - 1] : null;
  });

  // ---------------------------------------------------------------- core ops

  /** Applies a document recipe as an undoable step. */
  mutate<R>(recipe: (d: Draft<BoardDoc>) => R, opts: { txn?: string; label?: string } = {}): R {
    if (this.readOnly()) return undefined as R;
    const { state, result, changed } = this.history.apply(this.doc(), recipe as (d: Draft<BoardDoc>) => R, opts);
    if (changed) this.setDoc(state);
    return result;
  }

  private setDoc(next: BoardDoc): void {
    this.doc.set(next);
    this.docVersion.update((v) => v + 1);
    this.canUndo.set(this.history.canUndo);
    this.canRedo.set(this.history.canRedo);
    const nodes = next.nodes;
    const sel = this.selection();
    if ([...sel].some((id) => !nodes[id])) this.selection.set(new Set([...sel].filter((id) => nodes[id])));
    const editing = this.editingId();
    if (editing && !nodes[editing]) this.editingId.set(null);
    const edge = this.selectedEdge();
    if (edge && ((edge.type === 'link' && !next.links[edge.id]) || (edge.type === 'hierarchy' && !nodes[edge.childId])))
      this.selectedEdge.set(null);
  }

  sealHistory(): void {
    this.history.seal();
  }

  undo(): void {
    if (this.readOnly()) return;
    this.endEdit();
    const next = this.history.undo(this.doc());
    if (next) this.setDoc(next);
  }

  redo(): void {
    if (this.readOnly()) return;
    this.endEdit();
    const next = this.history.redo(this.doc());
    if (next) this.setDoc(next);
  }

  /** Replaces the whole board (load/switch); history restarts. */
  loadBoard(stored: Pick<StoredBoard, 'doc' | 'camera'>, readOnly = false): void {
    this.history = new History<BoardDoc>();
    this.selection.set(new Set());
    this.selectedEdge.set(null);
    this.editingId.set(null);
    this.tagFilter.set([]);
    this.readOnly.set(readOnly);
    this.doc.set(stored.doc);
    this.camera.set(stored.camera);
    this.canUndo.set(false);
    this.canRedo.set(false);
  }

  /** Board metadata update that does not belong in undo history. */
  renameBoard(name: string): void {
    const doc = this.doc();
    this.doc.set({ ...doc, name });
    this.docVersion.update((v) => v + 1);
  }

  announce(message: string): void {
    void this.announcer.announce(message, 'polite');
  }

  label(id: NodeId): string {
    const node = this.doc().nodes[id];
    if (!node) return '';
    if (node.kind === 'checklist') return richToPlain(node.text) || 'Checklist';
    return richToPlain(node.text) || 'Untitled';
  }

  // ---------------------------------------------------------- view helpers

  setTool(tool: ToolId): void {
    this.tool.set(tool);
  }

  select(ids: Iterable<NodeId>, additive = false): void {
    const next = new Set(additive ? this.selection() : []);
    for (const id of ids) next.add(id);
    this.selection.set(next);
    this.selectedEdge.set(null);
  }

  toggleSelect(id: NodeId): void {
    const next = new Set(this.selection());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selection.set(next);
    this.selectedEdge.set(null);
  }

  selectEdge(edge: EdgeRef | null): void {
    this.selectedEdge.set(edge);
    if (edge) this.selection.set(new Set());
  }

  clearSelection(): void {
    this.selection.set(new Set());
    this.selectedEdge.set(null);
  }

  selectAll(): void {
    this.select(this.visibleIds());
  }

  reportSize(id: NodeId, size: Size): void {
    const w = Math.ceil(size.w);
    const h = Math.ceil(size.h);
    const cur = this.sizes()[id];
    if (cur && cur.w === w && cur.h === h) return;
    this.sizes.update((s) => ({ ...s, [id]: { w, h } }));
  }

  sizeOf(id: NodeId): Size {
    return this.sizes()[id] ?? DEFAULT_SIZE;
  }

  beginEdit(id: NodeId, seed: string | null = null): void {
    if (this.readOnly()) return;
    // Keys left over from an earlier session must not leak into this one.
    if (!this.replaying) this.typeAhead.length = 0;
    this.select([id]);
    this.editSeed.set(seed);
    this.editSession.update((n) => n + 1);
    this.editingId.set(id);
  }

  endEdit(): void {
    if (this.editingId()) {
      this.editingId.set(null);
      this.editSeed.set(null);
      this.history.seal();
    }
  }

  commitText(id: NodeId, text: RichDoc, txn: string): void {
    this.mutate((d) => cmd.setText(d, id, text), { txn, label: 'Edit text' });
  }

  // --------------------------------------------------------- placement

  private obstacles(exclude: Set<NodeId> = new Set()): Rect[] {
    return [...this.rects()].filter(([id]) => !exclude.has(id)).map(([, r]) => r);
  }

  /** Free-mode position for a new child/sibling next to `anchorId`. */
  private placeNear(anchorId: NodeId, asChildOf: NodeId | null): Point {
    const rects = this.rects();
    const dir = this.settings().direction;
    const sp = spacingFor(dir);
    const anchor = rects.get(anchorId) ?? { ...DEFAULT_SIZE, x: 0, y: 0 };
    let candidate: Rect;
    if (asChildOf) {
      const parent = rects.get(asChildOf) ?? anchor;
      const kids = cmd.childrenOf(this.doc(), asChildOf).map((k) => rects.get(k)).filter((r): r is Rect => !!r);
      const last = kids[kids.length - 1];
      candidate =
        dir === 'vertical'
          ? { x: last ? last.x + last.w + sp.sibling : parent.x, y: parent.y + parent.h + sp.level, ...DEFAULT_SIZE }
          : { x: parent.x + parent.w + sp.level, y: last ? last.y + last.h + sp.sibling : parent.y, ...DEFAULT_SIZE };
    } else {
      candidate =
        dir === 'vertical'
          ? { x: anchor.x + anchor.w + sp.sibling, y: anchor.y, ...DEFAULT_SIZE }
          : { x: anchor.x, y: anchor.y + anchor.h + sp.sibling, ...DEFAULT_SIZE };
    }
    const p = findFreeSlot(candidate, this.obstacles(), dir);
    return this.settings().snap ? { x: snapValue(p.x), y: snapValue(p.y) } : p;
  }

  // ---------------------------------------------------------- structure

  createRootAt(world: Point, opts: { shape?: Shape; kind?: MindNode['kind']; edit?: boolean } = {}): NodeId {
    const snap = this.settings().snap;
    let p = snap ? { x: snapValue(world.x), y: snapValue(world.y) } : world;
    if (!this.settings().autoAlign) p = nudgeOutOfOverlap({ ...p, ...DEFAULT_SIZE }, this.obstacles());
    const id = this.mutate((d) => cmd.createRoot(d, { x: p.x, y: p.y, shape: opts.shape, kind: opts.kind }), {
      label: 'Add node',
    });
    if (!id) return id;
    this.announce('Node created');
    if (opts.edit !== false) this.beginEdit(id);
    else this.select([id]);
    return id;
  }

  addChild(parentId = this.primaryId(), edit = true): NodeId | null {
    if (!parentId) return null;
    const free = !this.settings().autoAlign;
    const p = free ? this.placeNear(parentId, parentId) : this.rects().get(parentId) ?? { x: 0, y: 0 };
    const id = this.mutate((d) => cmd.addChild(d, parentId, { x: p.x, y: p.y }), { label: 'Add child' });
    if (!id) return null;
    this.announce(`Child added under ${this.label(parentId)}`);
    if (edit) this.beginEdit(id);
    else this.select([id]);
    return id;
  }

  addSibling(refId = this.primaryId(), edit = true): NodeId | null {
    if (!refId) return null;
    const ref = this.doc().nodes[refId];
    if (!ref) return null;
    const free = !this.settings().autoAlign || !ref.parentId;
    const p = free ? this.placeNear(refId, null) : this.rects().get(refId) ?? { x: 0, y: 0 };
    const id = this.mutate((d) => cmd.addSibling(d, refId, { x: p.x, y: p.y }), { label: 'Add sibling' });
    if (!id) return null;
    this.announce(ref.parentId ? `Sibling added under ${this.label(ref.parentId)}` : 'Node created');
    if (edit) this.beginEdit(id);
    else this.select([id]);
    return id;
  }

  promote(id = this.primaryId()): void {
    if (!id) return;
    const pos = this.rects().get(id);
    const ok = this.mutate(
      (d) => {
        const r = cmd.promote(d, id);
        if (r && pos && !d.nodes[id].parentId) cmd.setPosition(d, id, pos.x, pos.y);
        return r;
      },
      { label: 'Promote' },
    );
    if (ok) this.announce(`Moved up a level`);
  }

  reorder(delta: number, id = this.primaryId()): void {
    if (!id) return;
    this.mutate((d) => cmd.reorder(d, id, delta), { label: 'Reorder' });
  }

  reparent(id: NodeId, target: DropTarget): boolean {
    const ok = this.mutate(
      (d) => {
        const r = cmd.reparent(d, id, target.parentId, target.index);
        if (r && !target.parentId && target.at) cmd.setPosition(d, id, target.at.x, target.at.y);
        return r;
      },
      { label: 'Move node' },
    );
    if (ok) this.announce(target.parentId ? `Moved under ${this.label(target.parentId)}` : 'Detached as a new root');
    return !!ok;
  }

  deleteSelection(): void {
    const edge = this.selectedEdge();
    if (edge) {
      this.deleteEdge(edge);
      return;
    }
    const ids = this.selectedIds();
    if (!ids.length) return;
    const doc = this.doc();
    const first = doc.nodes[ids[0]];
    const siblings = cmd.childrenOf(doc, first.parentId);
    const idx = siblings.indexOf(first.id);
    const removedSet = new Set<NodeId>();
    for (const id of ids) [id, ...cmd.descendantsOf(doc, id)].forEach((n) => removedSet.add(n));
    const fallback =
      first.parentId && !removedSet.has(first.parentId)
        ? first.parentId
        : [siblings[idx + 1], siblings[idx - 1]].find((s) => s && !removedSet.has(s)) ?? null;
    this.mutate((d) => cmd.deleteSubtrees(d, ids), { label: 'Delete' });
    this.announce(`${removedSet.size} node${removedSet.size === 1 ? '' : 's'} deleted`);
    this.select(fallback ? [fallback] : []);
  }

  deleteEdge(edge: EdgeRef): void {
    if (edge.type === 'link') {
      this.mutate((d) => cmd.removeLink(d, edge.id), { label: 'Delete link' });
      this.announce('Link deleted');
    } else {
      const pos = this.rects().get(edge.childId);
      this.mutate(
        (d) => {
          cmd.reparent(d, edge.childId, null);
          if (pos) cmd.setPosition(d, edge.childId, pos.x, pos.y);
        },
        { label: 'Detach' },
      );
      this.announce('Branch detached as a new root');
    }
    this.selectedEdge.set(null);
  }

  toggleCollapse(id = this.primaryId()): void {
    if (!id) return;
    const node = this.doc().nodes[id];
    if (!node || !cmd.childrenOf(this.doc(), id).length) return;
    const collapsed = !node.collapsed;
    this.mutate((d) => cmd.setCollapsed(d, id, collapsed), { label: collapsed ? 'Collapse' : 'Expand' });
    this.announce(collapsed ? 'Collapsed' : 'Expanded');
  }

  addLink(from: NodeId, to: NodeId): string | null {
    const id = this.mutate((d) => cmd.addLink(d, from, to), { label: 'Add link' });
    if (id) this.announce(`Linked ${this.label(from)} to ${this.label(to)}`);
    return id ?? null;
  }

  /** Free-mode move; repeated calls with the same txn form one undo step. */
  moveNodes(ids: NodeId[], positions: Map<NodeId, Point>, txn: string): void {
    this.mutate(
      (d) => {
        for (const id of ids) {
          const p = positions.get(id);
          if (p) cmd.setPosition(d, id, p.x, p.y);
        }
      },
      { txn, label: 'Move' },
    );
  }

  /** After a free drop: push moved nodes out of overlaps. */
  resolveDropOverlaps(ids: NodeId[], txn: string): void {
    const moving = new Set(ids);
    const obstacles = this.obstacles(moving);
    const rects = this.rects();
    const next = new Map<NodeId, Point>();
    for (const id of ids) {
      const r = rects.get(id);
      if (!r) continue;
      const p = nudgeOutOfOverlap(r, obstacles);
      if (p.x !== r.x || p.y !== r.y) next.set(id, p);
      obstacles.push({ ...r, ...p });
    }
    if (next.size) this.moveNodes([...next.keys()], next, txn);
  }

  // ------------------------------------------------------------- styling

  private styleTargets(ids?: NodeId[]): NodeId[] {
    return ids ?? this.selectedIds();
  }

  setShape(shape: Shape | undefined, ids?: NodeId[]): void {
    const t = this.styleTargets(ids);
    this.mutate((d) => t.forEach((id) => cmd.setShape(d, id, shape)), { label: 'Shape' });
  }

  setColor(color: ColorKey | undefined, ids?: NodeId[]): void {
    const t = this.styleTargets(ids);
    this.mutate((d) => t.forEach((id) => cmd.setColor(d, id, color)), { label: 'Color' });
  }

  setEmoji(emoji: string | undefined, ids?: NodeId[]): void {
    const t = this.styleTargets(ids);
    this.mutate((d) => t.forEach((id) => cmd.setEmoji(d, id, emoji)), { label: 'Emoji' });
  }

  toggleTag(tagId: string, ids?: NodeId[]): void {
    const t = this.styleTargets(ids);
    const doc = this.doc();
    const allHave = t.every((id) => doc.nodes[id]?.tags?.includes(tagId));
    this.mutate(
      (d) =>
        t.forEach((id) => {
          const cur = d.nodes[id].tags ?? [];
          cmd.setTags(d, id, allHave ? cur.filter((x) => x !== tagId) : [...new Set([...cur, tagId])], d.nodes[id].tagsMode);
        }),
      { label: 'Tags' },
    );
  }

  resetTags(ids?: NodeId[]): void {
    const t = this.styleTargets(ids);
    this.mutate((d) => t.forEach((id) => cmd.setTags(d, id, undefined, undefined)), { label: 'Tags' });
  }

  setTodo(on: boolean, ids?: NodeId[]): void {
    const t = this.styleTargets(ids);
    this.mutate((d) => t.forEach((id) => cmd.setTodo(d, id, on)), { label: 'Todo' });
  }

  setChecked(id: NodeId, checked: boolean): void {
    this.mutate((d) => cmd.setChecked(d, id, checked), { label: 'Check' });
  }

  setNote(id: NodeId, note: RichDoc | undefined, txn: string): void {
    this.mutate((d) => cmd.setNote(d, id, note), { txn, label: 'Note' });
  }

  updateItems(id: NodeId, items: MindNode['items'], txn?: string): void {
    this.mutate((d) => cmd.setItems(d, id, items ?? []), { txn, label: 'Checklist' });
  }

  convertToChecklist(id = this.primaryId()): void {
    if (!id) return;
    const doc = this.doc();
    const node = doc.nodes[id];
    if (!node || node.kind === 'checklist') return;
    const kids = cmd.childrenOf(doc, id);
    this.mutate(
      (d) => {
        const n = d.nodes[id];
        n.kind = 'checklist';
        n.items = kids.map((k) => ({ id: k, text: richToPlain(doc.nodes[k].text), checked: !!doc.nodes[k].checked }));
        cmd.deleteSubtrees(d, kids);
        delete n.todo;
      },
      { label: 'Convert to checklist' },
    );
  }

  updateSettings(patch: Partial<BoardSettings>): void {
    const turningOff = patch.autoAlign === false && this.settings().autoAlign;
    const positions = turningOff ? this.positions() : null;
    this.mutate(
      (d) => {
        // Bake computed layout positions so nodes stay put in free mode.
        if (positions) for (const [id, p] of positions) cmd.setPosition(d, id, p.x, p.y);
        cmd.setSettings(d, patch);
      },
      { label: 'Settings' },
    );
  }

  cycleDirection(): void {
    const order: BoardSettings['direction'][] = ['horizontal', 'vertical', 'balanced'];
    const next = order[(order.indexOf(this.settings().direction) + 1) % order.length];
    this.updateSettings({ direction: next });
    this.announce(`Layout ${next}`);
  }

  // ------------------------------------------------------------ clipboard

  private clipboard: { payload: cmd.ClipboardPayload; text: string } | null = null;

  copySelection(): string | null {
    const ids = this.selectedIds();
    if (!ids.length) return null;
    const payload = cmd.copySubtrees(this.doc(), ids);
    const text = this.payloadToText(payload);
    this.clipboard = { payload, text };
    return text;
  }

  cutSelection(): string | null {
    const text = this.copySelection();
    if (text) this.deleteSelection();
    return text;
  }

  private payloadToText(p: cmd.ClipboardPayload): string {
    const byParent = new Map<string, MindNode[]>();
    for (const n of p.nodes) {
      const k = n.parentId ?? ROOT_KEY;
      byParent.set(k, [...(byParent.get(k) ?? []), n]);
    }
    const lines: string[] = [];
    const visit = (n: MindNode, depth: number) => {
      lines.push('  '.repeat(depth) + richToPlain(n.text).replace(/\n/g, ' '));
      for (const c of byParent.get(n.id) ?? []) visit(c, depth + 1);
    };
    p.rootIds.forEach((rid) => {
      const n = p.nodes.find((x) => x.id === rid);
      if (n) visit(n, 0);
    });
    return lines.join('\n');
  }

  /** Pastes internal payload when the text matches the last copy, else parses indented text. */
  paste(text: string | null, at?: Point): void {
    const payload =
      this.clipboard && (text === null || text === this.clipboard.text)
        ? this.clipboard.payload
        : text
          ? cmd.parseIndentedText(text, textDoc)
          : null;
    if (!payload) return;
    const target = this.primaryId();
    let offset = { dx: 24, dy: 24 };
    if (!target) {
      const first = payload.nodes.find((n) => n.id === payload.rootIds[0]);
      const dest = at ?? this.viewCenterWorld();
      if (first) offset = { dx: dest.x - first.x, dy: dest.y - first.y };
    }
    const ids = this.mutate((d) => cmd.pasteSubtrees(d, payload, target, offset), { label: 'Paste' });
    if (ids?.length) {
      this.select(ids);
      this.announce(`${ids.length} item${ids.length === 1 ? '' : 's'} pasted`);
    }
  }

  duplicateSelection(): void {
    const ids = cmd.topLevel(this.doc(), this.selectedIds());
    if (!ids.length) return;
    const created: NodeId[] = [];
    this.mutate(
      (d) => {
        for (const id of ids) {
          const payload = cmd.copySubtrees(d as BoardDoc, [id]);
          const parent = d.nodes[id].parentId;
          const idx = cmd.childrenOf(d as BoardDoc, parent).indexOf(id);
          created.push(...cmd.pasteSubtrees(d, payload, parent, { dx: 24, dy: 24 }, idx + 1));
        }
      },
      { label: 'Duplicate' },
    );
    this.select(created);
  }

  viewCenterWorld(): Point {
    const cam = this.camera();
    const vp = this.viewport();
    return { x: (vp.w / 2 - cam.x) / cam.zoom, y: (vp.h / 2 - cam.y) / cam.zoom };
  }

  // --------------------------------------------------------------- camera

  zoomBy(factor: number, focus?: Point): void {
    const vp = this.viewport();
    this.camera.update((c) => zoomAt(c, c.zoom * factor, focus ?? { x: vp.w / 2, y: vp.h / 2 }));
  }

  zoomReset(): void {
    const vp = this.viewport();
    this.camera.update((c) => zoomAt(c, 1, { x: vp.w / 2, y: vp.h / 2 }));
  }

  fitToScreen(): void {
    this.camera.set(fitBounds(this.contentBounds(), this.viewport()));
  }

  centerOnWorld(p: Point): void {
    this.camera.update((c) => centerOn(c, p, this.viewport()));
  }

  /** Pans just enough to bring a node into view. */
  revealNode(id: NodeId): void {
    const r = this.rects().get(id);
    if (!r) return;
    const cam = this.camera();
    const vp = this.viewport();
    const pad = 48;
    const sx = r.x * cam.zoom + cam.x;
    const sy = r.y * cam.zoom + cam.y;
    const sw = r.w * cam.zoom;
    const sh = r.h * cam.zoom;
    let dx = 0;
    let dy = 0;
    if (sx < pad) dx = pad - sx;
    else if (sx + sw > vp.w - pad) dx = vp.w - pad - sx - sw;
    if (sy < pad) dy = pad - sy;
    else if (sy + sh > vp.h - pad) dy = vp.h - pad - sy - sh;
    if (dx || dy) this.camera.set({ ...cam, x: cam.x + dx, y: cam.y + dy });
  }
}
