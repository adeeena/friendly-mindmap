import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, inject, signal } from '@angular/core';
import { resolveEdgeStyle } from '../core/edge-style';
import { ColorKey, EDGE_PATTERNS, EDGE_WIDTHS, EdgePattern } from '../core/model';
import { EditorStore } from '../editor/editor-store';
import { MessageKey, t } from '../i18n';
import { ColorPalette } from './color-palette';

/** Line context menu: pattern, thickness and color of the selected edge. */
@Component({
  selector: 'bm-edge-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ColorPalette],
  host: {
    class: 'bm-menu bm-panel bm-context-menu bm-edge-menu',
    role: 'menu',
    '[attr.aria-label]': 't("edge.menu")',
    '[style.left.px]': 'pos().x',
    '[style.top.px]': 'top() ?? pos().y',
  },
  template: `
    <div role="group" class="bm-edge-row" [attr.aria-label]="t('edge.pattern')">
      @for (p of patterns; track p) {
        <button
          type="button"
          class="bm-button"
          role="menuitemradio"
          [attr.aria-checked]="resolved().pattern === p"
          (click)="set({ pattern: p })"
        >
          {{ patternLabel(p) }}
        </button>
      }
    </div>
    <div role="group" class="bm-edge-row" [attr.aria-label]="t('edge.thickness')">
      @for (w of widths; track w) {
        <button type="button" class="bm-button" role="menuitemradio" [attr.aria-label]="t('edge.width', { n: w })" [attr.aria-checked]="resolved().width === w" (click)="set({ width: w })">
          {{ w }}
        </button>
      }
    </div>
    <div role="group" [attr.aria-label]="t('edge.color')">
      <button type="button" class="bm-button" role="menuitemradio" [attr.aria-checked]="!resolved().color" (click)="set({ color: undefined })">
        <span class="bm-swatch bm-swatch-default"></span>
        {{ t('edge.colorDefault') }}
      </button>
      <bm-color-palette itemRole="menuitemradio" [value]="resolved().color" (picked)="set({ color: $event })" />
    </div>
    <button type="button" class="bm-button" role="menuitem" (click)="reset()">{{ t('edge.reset') }}</button>
  `,
})
export class EdgeMenu {
  protected readonly t = t;
  private readonly store = inject(EditorStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly patterns = EDGE_PATTERNS;
  protected readonly widths = EDGE_WIDTHS;
  /** Set when the menu would run past the bottom of the canvas. */
  protected readonly top = signal<number | null>(null);

  protected patternLabel(p: EdgePattern): string {
    return t(`edge.${p}` as MessageKey);
  }

  protected readonly pos = computed(() => this.store.edgeMenu() ?? { x: 0, y: 0 });
  protected readonly resolved = computed(() => {
    const edge = this.store.edgeMenu()?.edge;
    const doc = this.store.doc();
    const style = !edge ? undefined : edge.type === 'hierarchy' ? doc.nodes[edge.childId]?.edgeStyle : doc.links[edge.id]?.edgeStyle;
    return resolveEdgeStyle(style);
  });

  constructor() {
    afterNextRender(() => {
      const el = this.host.nativeElement;
      el.querySelector<HTMLElement>('button')?.focus();
      const parent = el.offsetParent as HTMLElement | null;
      const over = parent ? el.offsetTop + el.offsetHeight - parent.clientHeight : 0;
      if (over > 0) this.top.set(Math.max(4, el.offsetTop - over - 4));
    });
  }

  protected set(patch: { pattern?: EdgePattern; color?: ColorKey; width?: number }): void {
    const edge = this.store.edgeMenu()?.edge;
    if (edge) this.store.setEdgeStyle(edge, patch);
  }

  protected reset(): void {
    const edge = this.store.edgeMenu()?.edge;
    if (edge) this.store.setEdgeStyle(edge, null);
  }
}
