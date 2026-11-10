import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import { ColorKey, PaletteKey, TagDef, createId } from '../core/model';
import { removeTag, upsertTag } from '../core/commands';
import { EditorStore } from '../editor/editor-store';
import { colorName, t } from '../i18n';
import { ColorPalette } from './color-palette';
import { Icon } from './icon';

@Component({
  selector: 'bm-tag-manager',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, ColorPalette],
  host: { class: 'bm-dialog bm-panel bm-tags' },
  template: `
    <div class="bm-dialog-head">
      <h2 id="bm-tags-title">{{ t('tags.title') }}</h2>
      <button type="button" class="bm-button" [attr.aria-label]="t('common.close')" (click)="ref.close()"><bm-icon name="close" /></button>
    </div>
    <form class="bm-row" (submit)="add($event, newName.value); newName.value = ''">
      <label class="visually-hidden" for="bm-tag-new">{{ t('tags.newName') }}</label>
      <input id="bm-tag-new" #newName type="text" [attr.placeholder]="t('tags.newPlaceholder')" maxlength="40" cdkFocusInitial />
      <button
        type="button"
        class="bm-button"
        [attr.aria-label]="t('tags.color') + ': ' + colorName(newColor())"
        [attr.aria-expanded]="open() === 'new'"
        (click)="toggle('new')"
      >
        <span class="bm-swatch" [style.--swatch]="'var(--c-' + newColor() + ')'"></span>
      </button>
      <button type="submit" class="bm-button bm-primary"><bm-icon name="plus" /> {{ t('tags.add') }}</button>
    </form>
    @if (open() === 'new') {
      <bm-color-palette [label]="t('tags.color')" [value]="newColor()" (picked)="newColor.set($event); open.set(null)" />
    }
    <ul class="bm-tag-list" [attr.aria-label]="t('tags.list')">
      @for (tag of tags(); track tag.id) {
        <li class="bm-tag-item">
          <div class="bm-row">
            <button
              type="button"
              class="bm-button"
              [attr.aria-label]="t('tags.tagColor') + ': ' + colorName(tag.color)"
              [attr.aria-expanded]="open() === tag.id"
              (click)="toggle(tag.id)"
            >
              <span class="bm-swatch" [style.--swatch]="'var(--c-' + tag.color + ')'"></span>
            </button>
            <label class="visually-hidden" [attr.for]="'bm-tag-' + tag.id">{{ t('tags.name') }}</label>
            <input [id]="'bm-tag-' + tag.id" type="text" [value]="tag.name" maxlength="40" (change)="rename(tag, $any($event.target).value)" />
            <button type="button" class="bm-button" [attr.aria-label]="t('tags.filterBy', { name: tag.name })" [attr.aria-pressed]="filtered(tag.id)" (click)="toggleFilter(tag.id)">
              <bm-icon name="filter" />
            </button>
            <button type="button" class="bm-button" [attr.aria-label]="t('tags.delete', { name: tag.name })" (click)="remove(tag)"><bm-icon name="trash" /></button>
          </div>
          @if (open() === tag.id) {
            <bm-color-palette [label]="t('tags.tagColor')" [value]="tag.color" (picked)="recolor(tag, $event); open.set(null)" />
          }
        </li>
      } @empty {
        <li class="bm-muted">{{ t('tags.empty') }}</li>
      }
    </ul>
    @if (store.tagFilter().length) {
      <div class="bm-dialog-actions">
        <button type="button" class="bm-button" (click)="store.tagFilter.set([])">{{ t('tags.clearFilter') }}</button>
      </div>
    }
  `,
})
export class TagManager {
  protected readonly t = t;
  protected readonly colorName = colorName;
  protected readonly store = inject(EditorStore);
  protected readonly ref = inject(DialogRef);
  protected readonly tags = computed(() => Object.values(this.store.doc().tags));
  protected readonly newColor = signal<PaletteKey>('cobalt');
  /** Which color picker is expanded: the new-tag form ('new') or a tag id. */
  protected readonly open = signal<string | null>(null);

  protected toggle(key: string): void {
    this.open.update((cur) => (cur === key ? null : key));
  }

  protected add(e: Event, name: string): void {
    e.preventDefault();
    const clean = name.trim();
    const color = this.newColor();
    if (!clean) return;
    this.store.mutate((d) => upsertTag(d, { id: createId(), name: clean, color }), { label: 'Add tag' });
  }

  protected rename(t: TagDef, name: string): void {
    const clean = name.trim();
    if (clean) this.store.mutate((d) => upsertTag(d, { ...t, name: clean }), { label: 'Rename tag' });
  }

  protected recolor(t: TagDef, color: ColorKey): void {
    this.store.mutate((d) => upsertTag(d, { ...t, color }), { label: 'Tag color' });
  }

  protected remove(t: TagDef): void {
    this.store.mutate((d) => removeTag(d, t.id), { label: 'Delete tag' });
    this.store.tagFilter.update((f) => f.filter((x) => x !== t.id));
  }

  protected filtered(id: string): boolean {
    return this.store.tagFilter().includes(id);
  }

  protected toggleFilter(id: string): void {
    this.store.tagFilter.update((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));
  }
}
