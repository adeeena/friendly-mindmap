import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NodeId } from '../core/model';
import { EditorStore } from '../editor/editor-store';
import { center, hierarchyEdge, linkEdge, previewEdge } from '../editor/geometry';

interface DrawnEdge {
  key: string;
  d: string;
  hit: string;
  color: string | null;
  selected: boolean;
  dimmed: boolean;
  ref: string;
  ends: string;
}

@Component({
  selector: 'bm-edge-layer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'bm-edge-layer', 'aria-hidden': 'true' },
  template: `
    <svg class="bm-edges" overflow="visible" width="1" height="1" focusable="false">
      <defs>
        <marker id="bm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" class="bm-arrow-head" />
        </marker>
      </defs>
      @for (e of hierarchy(); track e.key) {
        <path
          class="bm-edge"
          [class.selected]="e.selected"
          [class.dimmed]="e.dimmed"
          [attr.d]="e.d"
          [attr.data-ends]="e.ends"
          [style.fill]="e.color"
        />
        <path class="bm-edge-hit" [attr.d]="e.hit" [attr.data-edge]="e.ref" [style.stroke-width.px]="hitWidth()" />
      }
      @for (e of links(); track e.key) {
        <path
          class="bm-link"
          [class.selected]="e.selected"
          [class.dimmed]="e.dimmed"
          [attr.d]="e.d"
          [attr.data-ends]="e.ends"
          [style.stroke]="e.color"
          marker-end="url(#bm-arrow)"
        />
        <path class="bm-edge-hit" [attr.d]="e.hit" [attr.data-edge]="e.ref" [style.stroke-width.px]="hitWidth()" />
      }
      @if (preview(); as p) {
        <path class="bm-link preview" [attr.d]="p" marker-end="url(#bm-arrow)" />
      }
    </svg>
  `,
})
export class EdgeLayer {
  private readonly store = inject(EditorStore);
  protected readonly hitWidth = computed(() => 12 / this.store.camera().zoom);

  /** Nearest visible ancestor (cross-links into collapsed branches). */
  private visibleEndpoint(id: NodeId): NodeId | null {
    const visible = this.store.visibleSet();
    const nodes = this.store.doc().nodes;
    let cur: NodeId | null = id;
    while (cur && !visible.has(cur)) cur = nodes[cur]?.parentId ?? null;
    return cur;
  }

  private colorOf(id: NodeId): string | null {
    const c = this.store.styles()[id]?.color;
    return c ? `var(--c-${c})` : null;
  }

  protected readonly hierarchy = computed<DrawnEdge[]>(() => {
    const doc = this.store.doc();
    const rects = this.store.displayRects();
    const dir = doc.settings.direction;
    const sel = this.store.selectedEdge();
    const filter = this.store.filterMatches();
    const out: DrawnEdge[] = [];
    for (const id of this.store.visibleIds()) {
      const parentId = doc.nodes[id].parentId;
      if (!parentId) continue;
      const pr = rects.get(parentId);
      const cr = rects.get(id);
      if (!pr || !cr) continue;
      const g = hierarchyEdge(pr, cr, dir);
      out.push({
        key: id,
        d: g.d,
        hit: g.center,
        color: this.colorOf(id),
        selected: sel?.type === 'hierarchy' && sel.childId === id,
        dimmed: !!filter && !(filter.has(id) && filter.has(parentId)),
        ref: `h:${id}`,
        ends: `${parentId},${id}`,
      });
    }
    return out;
  });

  protected readonly links = computed<DrawnEdge[]>(() => {
    const doc = this.store.doc();
    const rects = this.store.displayRects();
    const sel = this.store.selectedEdge();
    const filter = this.store.filterMatches();
    const out: DrawnEdge[] = [];
    for (const link of Object.values(doc.links)) {
      const from = this.visibleEndpoint(link.from);
      const to = this.visibleEndpoint(link.to);
      if (!from || !to || from === to) continue;
      const a = rects.get(from);
      const b = rects.get(to);
      if (!a || !b) continue;
      const g = linkEdge(a, b);
      out.push({
        key: link.id,
        d: g.d,
        hit: g.center,
        color: this.colorOf(link.from),
        selected: sel?.type === 'link' && sel.id === link.id,
        dimmed: !!filter && !(filter.has(link.from) || filter.has(link.to)),
        ref: `l:${link.id}`,
        ends: `${from},${to}`,
      });
    }
    return out;
  });

  protected readonly preview = computed(() => {
    const p = this.store.connectPreview();
    if (!p) return null;
    const r = this.store.rects().get(p.from);
    if (!r) return null;
    const c = center(r);
    if (Math.hypot(c.x - p.to.x, c.y - p.to.y) < 4) return null;
    return previewEdge(r, p.to);
  });
}
