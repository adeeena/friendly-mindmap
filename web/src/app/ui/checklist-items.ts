import { ApplicationRef, ChangeDetectionStrategy, Component, ElementRef, inject, input, signal } from '@angular/core';
import { ChecklistItem, createId } from '../core/model';
import { EditorStore, newTxn } from '../editor/editor-store';
import { t } from '../i18n';

/** Inline checklist items of a checklist node. */
@Component({
  selector: 'bm-checklist-items',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'bm-checklist' },
  template: `
    <ul role="list" [attr.aria-label]="t('checklist.itemsOf', { label: label() })">
      @for (item of items(); track item.id; let i = $index) {
        <li class="bm-check-row" [class.done]="item.checked">
          <input
            type="checkbox"
            class="bm-check"
            [checked]="item.checked"
            [attr.aria-label]="t('node.done', { text: item.text || t('checklist.emptyItem') })"
            (change)="toggle(item, $event)"
            [disabled]="store.readOnly()"
          />
          <input
            class="bm-check-text"
            type="text"
            [value]="item.text"
            [attr.data-item]="item.id"
            [attr.aria-label]="t('checklist.item', { n: i + 1 })"
            [readOnly]="store.readOnly()"
            (input)="edit(item, $event)"
            (keydown)="onKey($event, item, i)"
            (blur)="seal()"
          />
        </li>
      }
    </ul>
    @if (!store.readOnly()) {
      <button type="button" class="bm-add-item" (click)="add(items().length)">{{ t('checklist.add') }}</button>
    }
  `,
})
export class ChecklistItems {
  protected readonly t = t;
  protected readonly store = inject(EditorStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly appRef = inject(ApplicationRef);
  readonly nodeId = input.required<string>();
  readonly items = input.required<ChecklistItem[]>();
  readonly label = input(t('checklist.default'));
  private txn = signal(newTxn('items'));

  private save(items: ChecklistItem[], txn?: string): void {
    this.store.updateItems(this.nodeId(), items, txn);
  }

  protected toggle(item: ChecklistItem, e: Event): void {
    const checked = (e.target as HTMLInputElement).checked;
    this.save(this.current().map((i) => (i.id === item.id ? { ...i, checked } : i)));
  }

  protected edit(item: ChecklistItem, e: Event): void {
    const text = (e.target as HTMLInputElement).value;
    this.save(this.current().map((i) => (i.id === item.id ? { ...i, text } : i)), this.txn());
  }

  /** Live items; the input may lag behind within one tick of fast typing. */
  private current(): ChecklistItem[] {
    return this.store.doc().nodes[this.nodeId()]?.items ?? [];
  }

  protected seal(): void {
    this.store.sealHistory();
    this.txn.set(newTxn('items'));
  }

  protected add(index: number): void {
    const item = { id: createId(), text: '', checked: false };
    const items = [...this.current()];
    items.splice(index, 0, item);
    this.seal();
    this.save(items);
    this.focusItem(item.id);
  }

  protected onKey(e: KeyboardEvent, item: ChecklistItem, index: number): void {
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      this.add(index + 1);
    } else if (e.key === 'Backspace' && (e.target as HTMLInputElement).value === '') {
      e.preventDefault();
      const items = this.current().filter((i) => i.id !== item.id);
      this.seal();
      this.save(items);
      const prev = items[Math.max(0, index - 1)];
      if (prev) this.focusItem(prev.id);
      else this.host.nativeElement.closest<HTMLElement>('[data-node-id]')?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.host.nativeElement.closest<HTMLElement>('[data-node-id]')?.focus();
    }
  }

  private focusItem(id: string): void {
    // Render now so keys typed right after Enter land in the new item.
    this.appRef.tick();
    this.host.nativeElement.querySelector<HTMLInputElement>(`[data-item="${id}"]`)?.focus();
  }
}
