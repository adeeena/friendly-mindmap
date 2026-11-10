import { ChangeDetectionStrategy, Component, ElementRef, computed, inject } from '@angular/core';
import { EditorStore } from '../editor/editor-store';
import { centerOn } from '../editor/camera';
import { t } from '../i18n';

const W = 200;
const H = 140;

@Component({
  selector: 'bm-minimap',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'bm-minimap bm-panel',
    role: 'img',
    '[attr.aria-label]': 't("minimap.label")',
    '(pointerdown)': 'onDown($event)',
    '(pointermove)': 'onMove($event)',
    '(pointerup)': 'dragging = false',
  },
  template: `
    <svg [attr.width]="w" [attr.height]="h" [attr.viewBox]="'0 0 ' + w + ' ' + h" aria-hidden="true">
      @for (r of nodes(); track r.id) {
        <rect [attr.x]="r.x" [attr.y]="r.y" [attr.width]="r.w" [attr.height]="r.h" rx="1" [style.fill]="r.color" />
      }
      @if (view(); as v) {
        <rect class="bm-mini-view" [attr.x]="v.x" [attr.y]="v.y" [attr.width]="v.w" [attr.height]="v.h" />
      }
    </svg>
  `,
})
export class Minimap {
  protected readonly t = t;
  private readonly store = inject(EditorStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly w = W;
  protected readonly h = H;
  protected dragging = false;

  /** World rect covered by the minimap: content plus current view, padded. */
  private readonly frame = computed(() => {
    const cam = this.store.camera();
    const vp = this.store.viewport();
    const view = { x: -cam.x / cam.zoom, y: -cam.y / cam.zoom, w: vp.w / cam.zoom, h: vp.h / cam.zoom };
    const c = this.store.contentBounds() ?? view;
    const x0 = Math.min(c.x, view.x);
    const y0 = Math.min(c.y, view.y);
    const x1 = Math.max(c.x + c.w, view.x + view.w);
    const y1 = Math.max(c.y + c.h, view.y + view.h);
    const pad = 40;
    const ww = x1 - x0 + pad * 2;
    const hh = y1 - y0 + pad * 2;
    const scale = Math.min(W / ww, H / hh);
    return { x: x0 - pad - (W / scale - ww) / 2, y: y0 - pad - (H / scale - hh) / 2, scale, view };
  });

  protected readonly nodes = computed(() => {
    const f = this.frame();
    const styles = this.store.styles();
    return [...this.store.rects()].map(([id, r]) => ({
      id,
      x: (r.x - f.x) * f.scale,
      y: (r.y - f.y) * f.scale,
      w: Math.max(2, r.w * f.scale),
      h: Math.max(2, r.h * f.scale),
      color: styles[id]?.color ? `var(--c-${styles[id].color})` : 'var(--text-muted)',
    }));
  });

  protected readonly view = computed(() => {
    const f = this.frame();
    const v = f.view;
    return { x: (v.x - f.x) * f.scale, y: (v.y - f.y) * f.scale, w: v.w * f.scale, h: v.h * f.scale };
  });

  protected onDown(e: PointerEvent): void {
    e.stopPropagation();
    this.dragging = true;
    this.host.nativeElement.setPointerCapture?.(e.pointerId);
    this.moveTo(e);
  }

  protected onMove(e: PointerEvent): void {
    if (this.dragging) this.moveTo(e);
  }

  private moveTo(e: PointerEvent): void {
    const rect = this.host.nativeElement.querySelector('svg')!.getBoundingClientRect();
    const f = this.frame();
    const world = { x: (e.clientX - rect.left) / f.scale + f.x, y: (e.clientY - rect.top) / f.scale + f.y };
    this.store.camera.set(centerOn(this.store.camera(), world, this.store.viewport()));
  }
}
