import { ChangeDetectionStrategy, Component, ElementRef, inject, input, output } from '@angular/core';
import { ColorKey, PALETTE_KEYS, PALETTE_MORE, PALETTE_VIVID, PaletteKey } from '../core/model';
import { colorName } from '../i18n';

/** The shared color grid: bright colors first, a divider, then pastel, deep and neutral ones. */
@Component({
  selector: 'bm-color-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'bm-swatch-wrap',
    '[attr.role]': "itemRole() === 'radio' ? 'radiogroup' : 'group'",
    '[attr.aria-label]': 'label()',
    '(keydown)': 'onKey($event)',
  },
  template: `
    <div class="bm-swatch-grid">
      @for (c of vivid; track c) {
        <button
          type="button"
          class="bm-pal-swatch"
          [attr.role]="itemRole()"
          [attr.data-key]="c"
          [attr.aria-checked]="value() === c"
          [attr.aria-label]="name(c)"
          [attr.tabindex]="tabIndex(c)"
          [style.--swatch]="'var(--c-' + c + ')'"
          (click)="picked.emit(c)"
        ></button>
      }
    </div>
    <div class="bm-swatch-sep" aria-hidden="true"></div>
    <div class="bm-swatch-grid">
      @for (c of more; track c) {
        <button
          type="button"
          class="bm-pal-swatch"
          [attr.role]="itemRole()"
          [attr.data-key]="c"
          [attr.aria-checked]="value() === c"
          [attr.aria-label]="name(c)"
          [attr.tabindex]="tabIndex(c)"
          [style.--swatch]="'var(--c-' + c + ')'"
          (click)="picked.emit(c)"
        ></button>
      }
    </div>
  `,
})
export class ColorPalette {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly value = input<ColorKey | undefined>(undefined);
  readonly label = input('');
  /** `radio` for plain groups, `menuitemradio` inside a menu. */
  readonly itemRole = input<'radio' | 'menuitemradio'>('radio');
  readonly picked = output<PaletteKey>();

  protected readonly vivid = PALETTE_VIVID;
  protected readonly more = PALETTE_MORE;
  protected readonly name = colorName;

  /** One tab stop: the current color, or the first swatch when the color is not in the palette. */
  protected tabIndex(c: PaletteKey): number {
    const v = this.value();
    const current = v && (PALETTE_KEYS as readonly string[]).includes(v) ? v : PALETTE_KEYS[0];
    return c === current ? 0 : -1;
  }

  protected onKey(e: KeyboardEvent): void {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 4, ArrowUp: -4 }[e.key];
    const from = (e.target as HTMLElement).getAttribute?.('data-key');
    if (!step || !from) return;
    e.preventDefault();
    const i = PALETTE_KEYS.indexOf(from as PaletteKey) + step;
    const next = PALETTE_KEYS[Math.min(PALETTE_KEYS.length - 1, Math.max(0, i))];
    this.host.nativeElement.querySelector<HTMLElement>(`[data-key="${next}"]`)?.focus();
  }
}
