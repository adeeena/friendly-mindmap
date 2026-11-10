import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import { COLOR_KEYS, ColorKey, TagDef, createId } from '../core/model';
import { removeTag, upsertTag } from '../core/commands';
import { EditorStore } from '../editor/editor-store';
import { Icon } from './icon';

@Component({
  selector: 'bm-tag-manager',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'bm-dialog bm-panel bm-tags' },
  template: `
    <div class="bm-dialog-head">
      <h2 id="bm-tags-title">Tags</h2>
      <button type="button" class="bm-button" aria-label="Close" (click)="ref.close()"><bm-icon name="close" /></button>
    </div>
    <form class="bm-row" (submit)="add($event, newName.value, $any(newColor).value); newName.value = ''">
      <label class="visually-hidden" for="bm-tag-new">New tag name</label>
      <input id="bm-tag-new" #newName type="text" placeholder="New tag" maxlength="40" cdkFocusInitial />
      <label class="visually-hidden" for="bm-tag-new-color">Color</label>
      <select id="bm-tag-new-color" #newColor>
        @for (c of colors; track c) {
          <option [value]="c">{{ c }}</option>
        }
      </select>
      <button type="submit" class="bm-button bm-primary"><bm-icon name="plus" /> Add</button>
    </form>
    <ul class="bm-tag-list" aria-label="Board tags">
      @for (t of tags(); track t.id) {
        <li class="bm-row">
          <span class="bm-swatch" [style.--swatch]="'var(--c-' + t.color + ')'" aria-hidden="true"></span>
          <label class="visually-hidden" [attr.for]="'bm-tag-' + t.id">Tag name</label>
          <input [id]="'bm-tag-' + t.id" type="text" [value]="t.name" maxlength="40" (change)="rename(t, $any($event.target).value)" />
          <label class="visually-hidden" [attr.for]="'bm-tag-color-' + t.id">Tag color</label>
          <select [id]="'bm-tag-color-' + t.id" [value]="t.color" (change)="recolor(t, $any($event.target).value)">
            @for (c of colors; track c) {
              <option [value]="c" [selected]="c === t.color">{{ c }}</option>
            }
          </select>
          <button type="button" class="bm-button" [attr.aria-label]="'Filter by ' + t.name" [attr.aria-pressed]="filtered(t.id)" (click)="toggleFilter(t.id)">
            <bm-icon name="filter" />
          </button>
          <button type="button" class="bm-button" [attr.aria-label]="'Delete tag ' + t.name" (click)="remove(t)"><bm-icon name="trash" /></button>
        </li>
      } @empty {
        <li class="bm-muted">No tags yet. Tags you add here can be assigned from the selection toolbar.</li>
      }
    </ul>
    @if (store.tagFilter().length) {
      <div class="bm-dialog-actions">
        <button type="button" class="bm-button" (click)="store.tagFilter.set([])">Clear filter</button>
      </div>
    }
  `,
})
export class TagManager {
  protected readonly store = inject(EditorStore);
  protected readonly ref = inject(DialogRef);
  protected readonly colors = COLOR_KEYS;
  protected readonly tags = computed(() => Object.values(this.store.doc().tags));

  protected add(e: Event, name: string, color: ColorKey): void {
    e.preventDefault();
    const clean = name.trim();
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
