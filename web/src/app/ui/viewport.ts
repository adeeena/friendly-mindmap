import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { NodeId } from '../core/model';
import { EditorStore, EdgeRef } from '../editor/editor-store';
import { isEditableTarget } from '../editor/commands';
import { InteractionController, PointerInfo } from '../editor/interaction';
import { EdgeLayer } from './edge-layer';
import { NodeView } from './node-view';

const INTERACTIVE = 'button, input, textarea, select, a, [contenteditable="true"], .bm-rich-editor, .bm-checklist';
const LONG_PRESS_MS = 500;
const DOUBLE_TAP_MS = 400;

@Component({
  selector: 'bm-viewport',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EdgeLayer, NodeView],
  host: {
    class: 'bm-viewport',
    '[attr.data-tool]': 'cursorTool()',
    '[class.panning]': 'store.gesture()',
    '(pointerdown)': 'onPointerDown($event)',
    '(pointermove)': 'onPointerMove($event)',
    '(pointerup)': 'onPointerUp($event)',
    '(pointercancel)': 'onPointerCancel($event)',
    '(lostpointercapture)': 'onLostCapture($event)',
    '(contextmenu)': 'onContextMenu($event)',
    '(dblclick)': 'onDblClick($event)',
  },
  template: `
    <div class="bm-grid" [style.background-size]="gridSize()" [style.background-position]="gridPos()"></div>
    <div class="bm-world" [class.gesture]="store.gesture()" [style.transform]="worldTransform()">
      <bm-edge-layer />
      <div class="bm-nodes" role="tree" aria-label="Mind map" [attr.aria-multiselectable]="true">
        @for (id of store.visibleIds(); track id) {
          <bm-node [nodeId]="id" />
        }
      </div>
      <svg class="bm-overlay" overflow="visible" width="1" height="1" aria-hidden="true">
        @if (store.marquee(); as m) {
          <rect class="bm-marquee" [attr.x]="m.x" [attr.y]="m.y" [attr.width]="m.w" [attr.height]="m.h" [style.stroke-width.px]="1 / zoom()" />
        }
        @for (g of store.guides(); track $index) {
          @if (g.axis === 'x') {
            <line class="bm-guide" [attr.x1]="g.pos" [attr.x2]="g.pos" [attr.y1]="g.from" [attr.y2]="g.to" [style.stroke-width.px]="1 / zoom()" />
          } @else {
            <line class="bm-guide" [attr.y1]="g.pos" [attr.y2]="g.pos" [attr.x1]="g.from" [attr.x2]="g.to" [style.stroke-width.px]="1 / zoom()" />
          }
        }
        @if (insertionBar(); as b) {
          <line class="bm-insert" [attr.x1]="b.x1" [attr.y1]="b.y1" [attr.x2]="b.x2" [attr.y2]="b.y2" [style.stroke-width.px]="3 / zoom()" />
        }
        @if (rootDrop(); as r) {
          <rect class="bm-root-drop" [attr.x]="r.x" [attr.y]="r.y" [attr.width]="r.w" [attr.height]="r.h" rx="8" [style.stroke-width.px]="1.5 / zoom()" />
        }
      </svg>
    </div>
  `,
})
export class Viewport {
  protected readonly store = inject(EditorStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);
  readonly controller = new InteractionController(this.store);

  protected readonly zoom = computed(() => this.store.camera().zoom);
  protected readonly worldTransform = computed(() => {
    const c = this.store.camera();
    return `translate(${c.x}px, ${c.y}px) scale(${c.zoom})`;
  });
  protected readonly gridSize = computed(() => {
    let s = 24 * this.zoom();
    // Coarsen the dot grid when zoomed out so it never turns into noise.
    while (s < 12) s *= 4;
    return `${s}px ${s}px`;
  });
  protected readonly gridPos = computed(() => {
    const c = this.store.camera();
    return `${c.x}px ${c.y}px`;
  });
  protected readonly cursorTool = computed(() => (this.store.gesture() ? 'grabbing' : this.store.tool()));

  protected readonly insertionBar = computed(() => {
    const t = this.store.dropTarget();
    if (!t?.parentId || t.index === undefined) return null;
    const kids = this.store.doc().children[t.parentId] ?? [];
    const rects = this.store.rects();
    const vertical = this.store.settings().direction === 'vertical';
    const before = rects.get(kids[t.index - 1]);
    const after = rects.get(kids[t.index]);
    const ref = after ?? before;
    if (!ref) return null;
    if (vertical) {
      const x = after && before ? (before.x + before.w + after.x) / 2 : after ? after.x - 6 : before!.x + before!.w + 6;
      return { x1: x, y1: ref.y, x2: x, y2: ref.y + ref.h };
    }
    const y = after && before ? (before.y + before.h + after.y) / 2 : after ? after.y - 6 : before!.y + before!.h + 6;
    return { x1: ref.x, y1: y, x2: ref.x + ref.w, y2: y };
  });

  protected readonly rootDrop = computed(() => {
    const t = this.store.dropTarget();
    const preview = this.store.dragPreview();
    if (!t || t.parentId || !t.at || !preview) return null;
    const size = this.store.sizeOf(preview.ids[0]);
    return { x: t.at.x, y: t.at.y, ...size };
  });

  private pendingMove: PointerEvent | null = null;
  private raf = 0;
  private gestureTimer: ReturnType<typeof setTimeout> | null = null;
  private longPress: { timer: ReturnType<typeof setTimeout>; start: { x: number; y: number } } | null = null;
  private lastTap: { nodeId: NodeId; time: number } | null = null;

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const el = this.host.nativeElement;
      const ro = new ResizeObserver(() => this.store.viewport.set({ w: el.clientWidth, h: el.clientHeight }));
      ro.observe(el);
      const wheel = (e: WheelEvent) => this.onWheel(e);
      el.addEventListener('wheel', wheel, { passive: false });
      const keydown = (e: KeyboardEvent) => this.onKey(e, true);
      const keyup = (e: KeyboardEvent) => this.onKey(e, false);
      this.document.addEventListener('keydown', keydown);
      this.document.addEventListener('keyup', keyup);
      const blur = () => (this.controller.spaceHeld = false);
      this.document.defaultView?.addEventListener('blur', blur);
      destroyRef.onDestroy(() => {
        ro.disconnect();
        el.removeEventListener('wheel', wheel);
        this.document.removeEventListener('keydown', keydown);
        this.document.removeEventListener('keyup', keyup);
        this.document.defaultView?.removeEventListener('blur', blur);
        cancelAnimationFrame(this.raf);
      });
    });
  }

  private localPoint(e: { clientX: number; clientY: number }) {
    const r = this.host.nativeElement.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private hit(e: PointerEvent, useElementAtPoint: boolean): { nodeId: NodeId | null; edge: EdgeRef | null } {
    const target = useElementAtPoint
      ? this.document.elementFromPoint(e.clientX, e.clientY)
      : (e.target as Element | null);
    const nodeEl = target?.closest?.('[data-node-id]');
    const edgeAttr = target?.closest?.('[data-edge]')?.getAttribute('data-edge') ?? null;
    let edge: EdgeRef | null = null;
    if (edgeAttr?.startsWith('h:')) edge = { type: 'hierarchy', childId: edgeAttr.slice(2) };
    else if (edgeAttr?.startsWith('l:')) edge = { type: 'link', id: edgeAttr.slice(2) };
    return { nodeId: nodeEl?.getAttribute('data-node-id') ?? null, edge };
  }

  private info(e: PointerEvent, useElementAtPoint = false): PointerInfo {
    const { nodeId, edge } = this.hit(e, useElementAtPoint);
    return {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      button: e.button,
      screen: this.localPoint(e),
      shift: e.shiftKey,
      alt: e.altKey,
      nodeId,
      edge,
    };
  }

  protected onPointerDown(e: PointerEvent): void {
    const target = e.target as Element;
    const interactive = target.closest(INTERACTIVE);
    if (interactive && e.button === 0 && this.store.tool() === 'pointer' && !this.controller.spaceHeld) return;
    this.store.contextMenu.set(null);
    if (e.button > 1) return;
    if (e.button === 1) e.preventDefault();
    this.capture(e.pointerId, true);
    const info = this.info(e);
    this.controller.pointerDown(info);
    if (e.pointerType === 'touch' && info.nodeId) this.startLongPress(e, info.nodeId);
  }

  protected onPointerMove(e: PointerEvent): void {
    if (this.longPress) {
      const p = this.localPoint(e);
      if (Math.hypot(p.x - this.longPress.start.x, p.y - this.longPress.start.y) > 8) this.cancelLongPress();
    }
    if (this.controller.state.kind === 'idle') return;
    this.pendingMove = e;
    if (!this.raf) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        const ev = this.pendingMove;
        this.pendingMove = null;
        if (ev) this.controller.pointerMove(this.info(ev, this.controller.state.kind === 'connecting'));
      });
    }
  }

  protected onPointerUp(e: PointerEvent): void {
    this.cancelLongPress();
    if (this.pendingMove) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.controller.pointerMove(this.info(this.pendingMove));
      this.pendingMove = null;
    }
    const wasPointing = this.controller.state.kind === 'pointing';
    const info = this.info(e, true);
    this.controller.pointerUp(info);
    this.capture(e.pointerId, false);
    if (wasPointing && info.nodeId) this.detectDoubleTap(info.nodeId);
  }

  protected onPointerCancel(e: PointerEvent): void {
    this.cancelLongPress();
    this.controller.releasePointer(e.pointerId);
    if (this.controller.state.kind !== 'pinching') this.controller.cancel();
  }

  protected onLostCapture(e: PointerEvent): void {
    this.controller.releasePointer(e.pointerId);
  }

  private capture(pointerId: number, on: boolean): void {
    const el = this.host.nativeElement;
    try {
      if (on) el.setPointerCapture?.(pointerId);
      else if (el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId);
    } catch {
      // Pointer already released; interaction continues without capture.
    }
  }

  private detectDoubleTap(nodeId: NodeId): void {
    const now = performance.now();
    if (this.lastTap && this.lastTap.nodeId === nodeId && now - this.lastTap.time < DOUBLE_TAP_MS) {
      this.lastTap = null;
      if (this.store.editingId() !== nodeId && this.store.tool() === 'pointer') this.store.beginEdit(nodeId);
    } else {
      this.lastTap = { nodeId, time: now };
    }
  }

  private startLongPress(e: PointerEvent, nodeId: NodeId): void {
    this.cancelLongPress();
    const start = this.localPoint(e);
    const timer = setTimeout(() => {
      this.longPress = null;
      this.controller.cancel();
      this.store.select([nodeId]);
      this.store.contextMenu.set({ x: start.x, y: start.y, nodeId });
    }, LONG_PRESS_MS);
    this.longPress = { timer, start };
  }

  private cancelLongPress(): void {
    if (this.longPress) clearTimeout(this.longPress.timer);
    this.longPress = null;
  }

  /** Pointer capture retargets dblclick to the viewport, so resolve the node by position. */
  protected onDblClick(e: MouseEvent): void {
    const el = this.document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el.closest('input, button, .bm-checklist, [contenteditable="true"]')) return;
    const id = el.closest('[data-node-id]')?.getAttribute('data-node-id');
    if (id && this.store.tool() === 'pointer' && this.store.editingId() !== id) this.store.beginEdit(id);
  }

  protected onContextMenu(e: MouseEvent): void {
    const target = this.document.elementFromPoint(e.clientX, e.clientY) ?? (e.target as Element);
    const nodeEl = target.closest('[data-node-id]');
    if (!nodeEl || target.closest('[contenteditable="true"]')) return;
    e.preventDefault();
    const id = nodeEl.getAttribute('data-node-id')!;
    if (!this.store.selection().has(id)) this.store.select([id]);
    const p = this.localPoint(e);
    this.store.contextMenu.set({ x: p.x, y: p.y, nodeId: id });
  }

  private onWheel(e: WheelEvent): void {
    if ((e.target as Element).closest('.bm-rich-editor, .bm-checklist') && !e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.store.viewport().h : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    this.store.gesture.set(true);
    if (this.gestureTimer) clearTimeout(this.gestureTimer);
    this.gestureTimer = setTimeout(() => this.store.gesture.set(false), 120);
    if (e.ctrlKey || e.metaKey) {
      this.store.zoomBy(Math.exp(-dy * 0.01), this.localPoint(e));
    } else {
      this.store.camera.update((c) => ({ ...c, x: c.x - dx, y: c.y - dy }));
    }
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.key === ' ' || e.code === 'Space') {
      if (down && (isEditableTarget(e.target) || (e.target as Element)?.closest?.('button, [role="dialog"]'))) return;
      if (down) e.preventDefault();
      this.controller.spaceHeld = down;
      this.host.nativeElement.toggleAttribute('data-space', down);
      return;
    }
    if (down && e.key === 'Escape' && this.controller.state.kind !== 'idle') {
      e.preventDefault();
      this.controller.cancel();
    }
  }
}
