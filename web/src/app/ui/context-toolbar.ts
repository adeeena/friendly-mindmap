import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { CdkMenu, CdkMenuItem, CdkMenuItemCheckbox, CdkMenuItemRadio, CdkMenuTrigger } from '@angular/cdk/menu';
import { COLOR_KEYS, ColorKey, Shape } from '../core/model';
import { CommandRegistry } from '../editor/commands';
import { EditorStore } from '../editor/editor-store';
import { Icon } from './icon';

export const EMOJIS = [
  '⭐', '✅', '❗', '❓', '💡', '🔥', '🎯', '📌', '🚀', '⚠️',
  '🛒', '📅', '📝', '📎', '🔗', '💬', '👍', '👎', '❤️', '🎉',
  '🏠', '💼', '📚', '🧪', '🛠️', '💰', '✈️', '🍎', '🐞', '🔒',
];

@Component({
  selector: 'bm-context-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, CdkMenu, CdkMenuItem, CdkMenuItemRadio, CdkMenuItemCheckbox, CdkMenuTrigger],
  host: {
    class: 'bm-context-toolbar bm-panel',
    role: 'toolbar',
    'aria-label': 'Selection',
    '[hidden]': '!pos()',
  },
  template: `
    @if (pos()) {
      <div class="bm-tb-group" role="group" aria-label="Shape">
        @for (s of shapes; track s.id) {
          <button
            type="button"
            class="bm-button"
            [attr.aria-label]="s.label"
            [attr.title]="s.label"
            [attr.aria-pressed]="shape() === s.id"
            (click)="store.setShape(s.id)"
          >
            <bm-icon [name]="'shape-' + s.id" />
          </button>
        }
        @if (shapeOwn()) {
          <button type="button" class="bm-button bm-mini" title="Reset shape to inherited" aria-label="Reset shape to inherited" (click)="store.setShape(undefined)">↺</button>
        }
      </div>
      <span class="bm-tb-sep" aria-hidden="true"></span>
      <button type="button" class="bm-button" aria-label="Color" title="Color" [cdkMenuTriggerFor]="colorMenu">
        <span class="bm-swatch" [style.--swatch]="color() ? 'var(--c-' + color() + ')' : 'transparent'"></span>
      </button>
      <button type="button" class="bm-button" aria-label="Emoji" title="Emoji" [cdkMenuTriggerFor]="emojiMenu">
        @if (emoji()) {
          <span aria-hidden="true">{{ emoji() }}</span>
        } @else {
          <bm-icon name="emoji" />
        }
      </button>
      <button type="button" class="bm-button" aria-label="Tags" title="Tags" [cdkMenuTriggerFor]="tagMenu">
        <bm-icon name="tag" />
      </button>
      <span class="bm-tb-sep" aria-hidden="true"></span>
      <button
        type="button"
        class="bm-button"
        aria-label="Todo list for children"
        title="Todo list for children"
        [attr.aria-pressed]="todo()"
        (click)="store.setTodo(!todo())"
      >
        <bm-icon name="todo" />
      </button>
      @if (single() && canConvert()) {
        <button type="button" class="bm-button" aria-label="Convert to checklist" title="Convert to checklist" (click)="store.convertToChecklist()">
          <bm-icon name="checklist" />
        </button>
      }
      @if (single()) {
        <button type="button" class="bm-button" aria-label="Notes and attachments" title="Notes and attachments" [attr.aria-pressed]="store.notesOpen()" (click)="store.notesOpen.set(!store.notesOpen())">
          <bm-icon name="notes" />
        </button>
      }
      <button type="button" class="bm-button" aria-label="Delete" title="Delete" (click)="store.deleteSelection()">
        <bm-icon name="trash" />
      </button>
    }

    <ng-template #colorMenu>
      <div class="bm-menu bm-panel bm-color-grid" cdkMenu aria-label="Colors">
        @for (c of colors; track c) {
          <button
            type="button"
            class="bm-button"
            cdkMenuItemRadio
            [cdkMenuItemChecked]="color() === c"
            [attr.aria-label]="c"
            (cdkMenuItemTriggered)="setColor(c)"
          >
            <span class="bm-swatch" [style.--swatch]="'var(--c-' + c + ')'"></span>
          </button>
        }
        <button type="button" class="bm-button bm-wide" cdkMenuItem (cdkMenuItemTriggered)="setColor(undefined)">
          {{ colorInherited() ? 'Inherited' : 'Reset to inherited' }}
        </button>
      </div>
    </ng-template>
    <ng-template #emojiMenu>
      <div class="bm-menu bm-panel bm-emoji-grid" cdkMenu aria-label="Emoji">
        @for (e of emojis; track e) {
          <button type="button" class="bm-button" cdkMenuItemRadio [cdkMenuItemChecked]="emoji() === e" (cdkMenuItemTriggered)="store.setEmoji(e)">
            {{ e }}
          </button>
        }
        <button type="button" class="bm-button bm-wide" cdkMenuItem (cdkMenuItemTriggered)="store.setEmoji(undefined)">
          {{ emojiOwn() ? 'Reset to inherited' : 'None' }}
        </button>
      </div>
    </ng-template>
    <ng-template #tagMenu>
      <div class="bm-menu bm-panel" cdkMenu aria-label="Tags">
        @for (t of tags(); track t.id) {
          <button
            type="button"
            class="bm-button"
            cdkMenuItemCheckbox
            [cdkMenuItemChecked]="hasTag(t.id)"
            (cdkMenuItemTriggered)="store.toggleTag(t.id)"
          >
            <span class="bm-chip" [style.--chip]="'var(--c-' + t.color + ')'">{{ t.name }}</span>
            @if (hasTag(t.id)) {
              <bm-icon name="check" [size]="14" />
            }
          </button>
        } @empty {
          <p class="bm-menu-note">No tags yet.</p>
        }
        <button type="button" class="bm-button" cdkMenuItem (cdkMenuItemTriggered)="registry.run('tags.manage')">Manage tags…</button>
        <button type="button" class="bm-button" cdkMenuItem (cdkMenuItemTriggered)="store.resetTags()">Reset to inherited</button>
      </div>
    </ng-template>
  `,
})
export class ContextToolbar {
  protected readonly store = inject(EditorStore);
  protected readonly registry = inject(CommandRegistry);
  protected readonly colors = COLOR_KEYS;
  protected readonly emojis = EMOJIS;
  protected readonly shapes: { id: Shape; label: string }[] = [
    { id: 'none', label: 'Text only' },
    { id: 'rectangle', label: 'Rectangle' },
    { id: 'rounded', label: 'Rounded' },
  ];

  private readonly ids = computed(() => this.store.selectedIds());
  private readonly primary = computed(() => this.store.primaryId());
  protected readonly single = computed(() => this.ids().length === 1);
  private readonly primaryStyle = computed(() => {
    const p = this.primary();
    return p ? this.store.styles()[p] : null;
  });
  private readonly primaryNode = computed(() => {
    const p = this.primary();
    return p ? this.store.doc().nodes[p] : null;
  });
  protected readonly shape = computed(() => this.primaryStyle()?.shape);
  protected readonly shapeOwn = computed(() => this.primaryNode()?.shape !== undefined && !!this.primaryNode()?.parentId);
  protected readonly color = computed(() => this.primaryStyle()?.color);
  protected readonly colorInherited = computed(() => this.primaryNode()?.color === undefined);
  protected readonly emoji = computed(() => this.primaryStyle()?.emoji);
  protected readonly emojiOwn = computed(() => this.primaryNode()?.emoji !== undefined);
  protected readonly todo = computed(() => !!this.primaryNode()?.todo);
  protected readonly tags = computed(() => Object.values(this.store.doc().tags));
  protected readonly canConvert = computed(() => this.primaryNode()?.kind === 'topic');

  /** Docked at the top of the canvas so it never covers neighbouring nodes. */
  protected readonly pos = computed(() => {
    const ids = this.ids();
    if (!ids.length || this.store.editingId() || this.store.dragging() || this.store.readOnly()) return null;
    if (this.store.tool() !== 'pointer' || this.store.marquee()) return null;
    return true;
  });

  protected hasTag(tagId: string): boolean {
    const nodes = this.store.doc().nodes;
    return this.ids().every((id) => nodes[id]?.tags?.includes(tagId));
  }

  protected setColor(c: ColorKey | undefined): void {
    this.store.setColor(c);
  }
}
