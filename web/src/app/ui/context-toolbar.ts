import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { CdkMenu, CdkMenuItem, CdkMenuItemCheckbox, CdkMenuItemRadio, CdkMenuTrigger } from '@angular/cdk/menu';
import { ColorKey, PALETTE_MORE, PALETTE_VIVID, Shape } from '../core/model';
import { CommandRegistry } from '../editor/commands';
import { EditorStore } from '../editor/editor-store';
import { MessageKey, colorName, t } from '../i18n';
import { Icon } from './icon';

@Component({
  selector: 'bm-context-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, CdkMenu, CdkMenuItem, CdkMenuItemRadio, CdkMenuItemCheckbox, CdkMenuTrigger],
  host: {
    class: 'bm-context-toolbar bm-panel',
    role: 'toolbar',
    '[attr.aria-label]': 't("selection.label")',
    '[hidden]': '!pos()',
  },
  template: `
    @if (pos()) {
      <div class="bm-tb-group" role="group" [attr.aria-label]="t('selection.shape')">
        @for (s of shapes; track s.id) {
          <button
            type="button"
            class="bm-button"
            [attr.aria-label]="t(s.label)"
            [attr.title]="t(s.label)"
            [attr.aria-pressed]="shape() === s.id"
            (click)="store.setShape(s.id)"
          >
            <bm-icon [name]="'shape-' + s.id" />
          </button>
        }
        @if (shapeOwn()) {
          <button type="button" class="bm-button bm-mini" [attr.title]="t('selection.resetShape')" [attr.aria-label]="t('selection.resetShape')" (click)="store.setShape(undefined)">↺</button>
        }
      </div>
      <span class="bm-tb-sep" aria-hidden="true"></span>
      <button type="button" class="bm-button" [attr.aria-label]="t('selection.color')" [attr.title]="t('selection.color')" [cdkMenuTriggerFor]="colorMenu">
        <span class="bm-swatch" [style.--swatch]="color() ? 'var(--c-' + color() + ')' : 'transparent'"></span>
      </button>
      <button
        type="button"
        class="bm-button"
        [attr.aria-label]="t('selection.emoji')"
        [attr.title]="t('selection.emoji')"
        aria-haspopup="dialog"
        [attr.aria-expanded]="store.emojiPicker()"
        (click)="store.emojiPicker.set(!store.emojiPicker())"
      >
        @if (emoji()) {
          <span aria-hidden="true">{{ emoji() }}</span>
        } @else {
          <bm-icon name="emoji" />
        }
      </button>
      <button type="button" class="bm-button" [attr.aria-label]="t('selection.tags')" [attr.title]="t('selection.tags')" [cdkMenuTriggerFor]="tagMenu">
        <bm-icon name="tag" />
      </button>
      <span class="bm-tb-sep" aria-hidden="true"></span>
      <button
        type="button"
        class="bm-button"
        [attr.aria-label]="t('selection.todo')"
        [attr.title]="t('selection.todo')"
        [attr.aria-pressed]="todo()"
        (click)="store.setTodo(!todo())"
      >
        <bm-icon name="todo" />
      </button>
      @if (single() && canConvert()) {
        <button type="button" class="bm-button" [attr.aria-label]="t('selection.convert')" [attr.title]="t('selection.convert')" (click)="store.convertToChecklist()">
          <bm-icon name="checklist" />
        </button>
      }
      @if (single()) {
        <button type="button" class="bm-button" [attr.aria-label]="t('selection.notes')" [attr.title]="t('selection.notes')" [attr.aria-pressed]="store.notesOpen()" (click)="store.notesOpen.set(!store.notesOpen())">
          <bm-icon name="notes" />
        </button>
      }
      <button type="button" class="bm-button" [attr.aria-label]="t('selection.delete')" [attr.title]="t('selection.delete')" (click)="store.deleteSelection()">
        <bm-icon name="trash" />
      </button>
    }

    <ng-template #colorMenu>
      <div class="bm-menu bm-panel bm-color-menu" cdkMenu [attr.aria-label]="t('selection.colors')">
        <div class="bm-swatch-grid" role="group" [attr.aria-label]="t('selection.color')">
          @for (c of vivid; track c) {
            <button type="button" class="bm-pal-swatch" cdkMenuItemRadio [cdkMenuItemChecked]="color() === c" [attr.aria-label]="colorName(c)" [style.--swatch]="'var(--c-' + c + ')'" (cdkMenuItemTriggered)="setColor(c)"></button>
          }
        </div>
        <div class="bm-swatch-sep" role="separator"></div>
        <div class="bm-swatch-grid" role="group" [attr.aria-label]="t('selection.color')">
          @for (c of more; track c) {
            <button type="button" class="bm-pal-swatch" cdkMenuItemRadio [cdkMenuItemChecked]="color() === c" [attr.aria-label]="colorName(c)" [style.--swatch]="'var(--c-' + c + ')'" (cdkMenuItemTriggered)="setColor(c)"></button>
          }
        </div>
        <button type="button" class="bm-button" cdkMenuItem (cdkMenuItemTriggered)="setColor(undefined)">
          {{ colorInherited() ? t('selection.inherited') : t('selection.resetInherited') }}
        </button>
      </div>
    </ng-template>
    <ng-template #tagMenu>
      <div class="bm-menu bm-panel" cdkMenu [attr.aria-label]="t('selection.tags')">
        @for (tag of tags(); track tag.id) {
          <button
            type="button"
            class="bm-button"
            cdkMenuItemCheckbox
            [cdkMenuItemChecked]="hasTag(tag.id)"
            (cdkMenuItemTriggered)="store.toggleTag(tag.id)"
          >
            <span class="bm-chip" [style.--chip]="'var(--c-' + tag.color + ')'">{{ tag.name }}</span>
            @if (hasTag(tag.id)) {
              <bm-icon name="check" [size]="14" />
            }
          </button>
        } @empty {
          <p class="bm-menu-note">{{ t('selection.noTags') }}</p>
        }
        <button type="button" class="bm-button" cdkMenuItem (cdkMenuItemTriggered)="registry.run('tags.manage')">{{ t('selection.manageTags') }}</button>
        <button type="button" class="bm-button" cdkMenuItem (cdkMenuItemTriggered)="store.resetTags()">{{ t('selection.resetInherited') }}</button>
      </div>
    </ng-template>
  `,
})
export class ContextToolbar {
  protected readonly t = t;
  protected readonly store = inject(EditorStore);
  protected readonly registry = inject(CommandRegistry);
  protected readonly vivid = PALETTE_VIVID;
  protected readonly more = PALETTE_MORE;
  protected readonly shapes: { id: Shape; label: MessageKey }[] = [
    { id: 'none', label: 'shape.none' },
    { id: 'rectangle', label: 'shape.rectangle' },
    { id: 'rounded', label: 'shape.rounded' },
  ];

  protected readonly colorName = colorName;

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
  protected readonly todo = computed(() => !!this.primaryNode()?.todo);
  protected readonly tags = computed(() => Object.values(this.store.doc().tags));
  protected readonly canConvert = computed(() => this.primaryNode()?.kind === 'topic');

  /** Docked at the top of the canvas so it never covers neighbouring nodes. */
  protected readonly pos = computed(() => (this.store.selectionToolbarVisible() ? true : null));

  protected hasTag(tagId: string): boolean {
    const nodes = this.store.doc().nodes;
    return this.ids().every((id) => nodes[id]?.tags?.includes(tagId));
  }

  protected setColor(c: ColorKey | undefined): void {
    this.store.setColor(c);
  }
}
