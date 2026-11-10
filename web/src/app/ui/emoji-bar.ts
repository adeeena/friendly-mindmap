import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, effect, inject, signal } from '@angular/core';
import { EditorStore } from '../editor/editor-store';
import { MessageKey, t } from '../i18n';
import { Icon } from './icon';
import { EMOJI_CATEGORIES, QuickEmojis, firstEmoji } from './quick-emojis';

/** One-click emoji bar under the selection toolbar, plus the full picker as a popover. */
@Component({
  selector: 'bm-emoji-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'bm-emoji-host' },
  template: `
    @if (store.selectionBarVisible()) {
      <div class="bm-emoji-bar bm-panel" role="toolbar" [attr.aria-label]="t('emoji.quick')">
        @for (e of quick.all(); track e) {
          <button type="button" class="bm-button bm-emoji-btn" [attr.aria-pressed]="active(e)" (click)="choose(e)">{{ e }}</button>
        }
        <button
          type="button"
          class="bm-button"
          aria-haspopup="dialog"
          [attr.aria-expanded]="store.emojiPicker()"
          [attr.aria-label]="t('emoji.more')"
          [attr.title]="t('emoji.more')"
          (click)="store.emojiPicker.set(!store.emojiPicker())"
        >
          <bm-icon name="emoji" />
        </button>
      </div>
      @if (store.emojiPicker()) {
        <div class="bm-emoji-pop bm-panel" role="dialog" [attr.aria-label]="t('emoji.picker')" (keydown.escape)="store.emojiPicker.set(false)">
          <form class="bm-row" (submit)="useTyped($event, typed.value); typed.value = ''">
            <label class="visually-hidden" for="bm-emoji-input">{{ t('emoji.input') }}</label>
            <input id="bm-emoji-input" #typed type="text" autocomplete="off" [attr.placeholder]="t('emoji.input')" (input)="invalid.set(false)" />
            <button type="submit" class="bm-button">{{ t('emoji.use') }}</button>
          </form>
          @if (invalid()) {
            <p class="bm-error" role="alert">{{ t('emoji.invalid') }}</p>
          }
          <div class="bm-emoji-scroll">
            @for (cat of categories; track cat.id) {
              <section [attr.aria-labelledby]="'bm-emoji-cat-' + cat.id">
                <h2 class="bm-emoji-cat" [id]="'bm-emoji-cat-' + cat.id">{{ categoryName(cat.id) }}</h2>
                <div class="bm-emoji-grid">
                  @for (e of cat.emojis; track e) {
                    <button type="button" class="bm-button bm-emoji-btn" [attr.aria-pressed]="active(e)" (click)="pick(e)">{{ e }}</button>
                  }
                </div>
              </section>
            }
          </div>
          @if (hasOwn()) {
            <button type="button" class="bm-button" (click)="clear()">{{ t('emoji.none') }}</button>
          }
        </div>
      }
    }
  `,
})
export class EmojiBar {
  protected readonly t = t;
  protected readonly store = inject(EditorStore);
  protected readonly quick = inject(QuickEmojis);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly categories = EMOJI_CATEGORIES;
  protected readonly invalid = signal(false);

  protected readonly hasOwn = computed(() => {
    const nodes = this.store.doc().nodes;
    return this.store.selectedIds().some((id) => nodes[id]?.emoji !== undefined);
  });

  constructor() {
    // The picker belongs to the selection bar: it closes with it.
    effect(() => {
      if (!this.store.selectionBarVisible()) this.store.emojiPicker.set(false);
    });
    afterRenderEffect(() => {
      if (this.store.emojiPicker()) this.host.nativeElement.querySelector<HTMLElement>('.bm-emoji-pop .bm-emoji-btn')?.focus();
    });
  }

  protected categoryName(id: string): string {
    return t(`emoji.${id}` as MessageKey);
  }

  /** True when every selected node carries this emoji itself. */
  protected active(emoji: string): boolean {
    const nodes = this.store.doc().nodes;
    const ids = this.store.selectedIds();
    return ids.length > 0 && ids.every((id) => nodes[id]?.emoji === emoji);
  }

  /** A quick-bar click sets the emoji, or removes it when the selection already has it. */
  protected choose(emoji: string): void {
    this.store.setEmoji(this.active(emoji) ? undefined : emoji);
  }

  /** A pick from the picker sets the emoji and adds it to the quick list. */
  protected pick(emoji: string): void {
    this.store.setEmoji(emoji);
    this.quick.remember(emoji);
    this.store.emojiPicker.set(false);
  }

  protected useTyped(e: Event, text: string): void {
    e.preventDefault();
    const emoji = firstEmoji(text);
    if (emoji) this.pick(emoji);
    else this.invalid.set(!!text.trim());
  }

  protected clear(): void {
    this.store.setEmoji(undefined);
    this.store.emojiPicker.set(false);
  }
}
