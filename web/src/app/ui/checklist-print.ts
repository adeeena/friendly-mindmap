import { ChangeDetectionStrategy, Component, afterNextRender, input, signal } from '@angular/core';
import { ChecklistData, checklistOf, checklistProgress } from '../io/checklist-export';
import { t } from '../i18n';
import { IndexedDbBoardRepository } from '../persistence/indexeddb-repository';
import { migrateBoard } from '../persistence/migrations';

@Component({
  selector: 'bm-checklist-print',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'bm-print' },
  template: `
    <main>
      @if (data(); as c) {
        <h1>{{ c.title }}</h1>
        <p class="bm-print-meta">{{ progress(c) }}</p>
        <ul>
          @for (i of c.items; track $index) {
            <li [class.done]="i.checked"><span class="box" aria-hidden="true">{{ i.checked ? '☑' : '☐' }}</span> {{ i.text }}</li>
          }
        </ul>
        <button type="button" class="bm-button no-print" (click)="print()">{{ t('print.print') }}</button>
      } @else if (error()) {
        <p role="alert">{{ error() }}</p>
      } @else {
        <p>{{ t('common.loading') }}</p>
      }
    </main>
  `,
  styles: `
    :host { display: block; height: 100%; overflow: auto; background: #fff; color: #111; }
    main { max-width: 640px; margin: 2rem auto; padding: 0 1rem; font-size: 16px; }
    h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
    ul { list-style: none; padding: 0; }
    li { padding: 0.4rem 0; border-bottom: 1px solid #ddd; }
    li.done { color: #555; text-decoration: line-through; }
    .box { display: inline-block; width: 1.4em; }
    .bm-print-meta { color: #444; }
    @media print { .no-print { display: none; } main { margin: 0; } }
  `,
})
export class ChecklistPrint {
  protected readonly t = t;
  readonly boardId = input.required<string>();
  readonly nodeId = input.required<string>();
  protected readonly data = signal<ChecklistData | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    afterNextRender(() => void this.load());
  }

  private async load(): Promise<void> {
    try {
      const rec = await new IndexedDbBoardRepository().load(this.boardId());
      const c = rec ? checklistOf(migrateBoard(rec).doc, this.nodeId()) : null;
      if (!c) throw new Error();
      this.data.set(c);
      document.title = t('print.title', { title: c.title });
      setTimeout(() => window.print(), 300);
    } catch {
      this.error.set(t('print.notFound'));
    }
  }

  protected progress(c: ChecklistData): string {
    const p = checklistProgress(c);
    return t('node.ariaProgress', { done: p.done, total: p.total });
  }

  protected print(): void {
    window.print();
  }
}
