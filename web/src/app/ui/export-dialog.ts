import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { EditorStore } from '../editor/editor-store';
import { EditorActions } from './editor-actions';
import { Icon } from './icon';

export type ExportTab = 'file' | 'mermaid' | 'image' | 'checklist';

@Component({
  selector: 'bm-export-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'bm-dialog bm-panel bm-export' },
  template: `
    <div class="bm-dialog-head">
      <h2 id="bm-export-title">Save &amp; export</h2>
      <button type="button" class="bm-button" aria-label="Close" (click)="ref.close()"><bm-icon name="close" /></button>
    </div>
    <div class="bm-tabs" role="tablist" aria-label="Export type">
      @for (t of tabs(); track t.id) {
        <button
          type="button"
          role="tab"
          class="bm-button"
          [id]="'bm-tab-' + t.id"
          [attr.aria-selected]="tab() === t.id"
          [attr.aria-controls]="'bm-panel-' + t.id"
          [attr.tabindex]="tab() === t.id ? 0 : -1"
          (click)="tab.set(t.id)"
          (keydown)="tabKey($event)"
        >
          {{ t.label }}
        </button>
      }
    </div>
    <section role="tabpanel" [id]="'bm-panel-' + tab()" [attr.aria-labelledby]="'bm-tab-' + tab()" class="bm-tabpanel">
      @switch (tab()) {
        @case ('file') {
          <p>Save the whole board as a Better Mindmap file you can load later.</p>
          <label class="bm-check-label">
            <input type="checkbox" [checked]="withAttachments()" (change)="withAttachments.set($any($event.target).checked)" [disabled]="!actions.hasAttachments()" />
            Embed attachments (.bmm.zip)
          </label>
          <div class="bm-dialog-actions">
            <button type="button" class="bm-button bm-primary" cdkFocusInitial (click)="save()"><bm-icon name="save" /> Save file</button>
          </div>
        }
        @case ('mermaid') {
          <p class="bm-warning" role="note">
            Mermaid keeps the hierarchy and text only. Positions, cross-links, colors, tags, notes and attachments are not included.
          </p>
          <label for="bm-mermaid-text" class="visually-hidden">Mermaid text</label>
          <textarea id="bm-mermaid-text" class="bm-code" readonly rows="10" [value]="mermaid()"></textarea>
          <div class="bm-dialog-actions">
            <button type="button" class="bm-button" (click)="actions.copyText(mermaid(), 'Mermaid')"><bm-icon name="copy" /> Copy</button>
            <button type="button" class="bm-button bm-primary" (click)="actions.downloadMermaid()"><bm-icon name="download" /> Download .mmd</button>
          </div>
        }
        @case ('image') {
          <fieldset>
            <legend>Format</legend>
            <label><input type="radio" name="fmt" [checked]="format() === 'png'" (change)="format.set('png')" /> PNG</label>
            <label><input type="radio" name="fmt" [checked]="format() === 'svg'" (change)="format.set('svg')" /> SVG</label>
          </fieldset>
          @if (format() === 'png') {
            <fieldset>
              <legend>Resolution</legend>
              <label><input type="radio" name="res" [checked]="ratio() === 1" (change)="ratio.set(1)" /> 1x</label>
              <label><input type="radio" name="res" [checked]="ratio() === 2" (change)="ratio.set(2)" /> 2x</label>
            </fieldset>
          }
          <fieldset>
            <legend>Content</legend>
            <label><input type="radio" name="scope" [checked]="!selectionOnly()" (change)="selectionOnly.set(false)" /> Whole board</label>
            <label>
              <input type="radio" name="scope" [checked]="selectionOnly()" [disabled]="!hasSelection()" (change)="selectionOnly.set(true)" />
              Selection
            </label>
          </fieldset>
          <label class="bm-check-label"><input type="checkbox" [checked]="forceLight()" (change)="forceLight.set($any($event.target).checked)" /> Light theme</label>
          <label class="bm-check-label"><input type="checkbox" [checked]="background()" (change)="background.set($any($event.target).checked)" /> Background</label>
          <div class="bm-dialog-actions">
            <button type="button" class="bm-button bm-primary" [disabled]="busy()" (click)="image()"><bm-icon name="download" /> Export image</button>
          </div>
        }
        @case ('checklist') {
          @if (checklist(); as c) {
            <p>Export “{{ c.title }}” ({{ c.items.length }} items).</p>
            <div class="bm-dialog-actions bm-wrap">
              <button type="button" class="bm-button" (click)="actions.copyChecklist('markdown')"><bm-icon name="copy" /> Markdown</button>
              <button type="button" class="bm-button" (click)="actions.copyChecklist('text')"><bm-icon name="copy" /> Plain text</button>
              @if (actions.canShare()) {
                <button type="button" class="bm-button" (click)="actions.shareChecklist()"><bm-icon name="share" /> Share…</button>
              }
              <button type="button" class="bm-button" (click)="actions.printChecklist()"><bm-icon name="print" /> Print view</button>
            </div>
          }
        }
      }
    </section>
  `,
})
export class ExportDialog {
  protected readonly ref = inject(DialogRef);
  protected readonly actions = inject(EditorActions);
  private readonly store = inject(EditorStore);
  private readonly data = inject<{ tab?: ExportTab } | null>(DIALOG_DATA, { optional: true });

  protected readonly checklist = computed(() => this.actions.checklistFor());
  protected readonly tabs = computed(() => {
    const t: { id: ExportTab; label: string }[] = [
      { id: 'file', label: 'File' },
      { id: 'mermaid', label: 'Mermaid' },
      { id: 'image', label: 'Image' },
    ];
    if (this.checklist()) t.push({ id: 'checklist', label: 'Checklist' });
    return t;
  });
  protected readonly tab = signal<ExportTab>(this.data?.tab ?? 'file');
  protected readonly withAttachments = signal(false);
  protected readonly format = signal<'png' | 'svg'>('png');
  protected readonly ratio = signal<1 | 2>(2);
  protected readonly hasSelection = computed(() => this.store.selectedIds().length > 0);
  protected readonly selectionOnly = signal(false);
  protected readonly forceLight = signal(false);
  protected readonly background = signal(true);
  protected readonly busy = signal(false);
  protected readonly mermaid = computed(() => this.actions.mermaid());

  protected tabKey(e: KeyboardEvent): void {
    const ids = this.tabs().map((t) => t.id);
    const i = ids.indexOf(this.tab());
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + ids.length) % ids.length;
    else return;
    e.preventDefault();
    this.tab.set(ids[next]);
    setTimeout(() => document.getElementById('bm-tab-' + ids[next])?.focus());
  }

  protected async save(): Promise<void> {
    await this.actions.saveFile(this.withAttachments());
    this.ref.close();
  }

  protected async image(): Promise<void> {
    this.busy.set(true);
    await this.actions.exportImage({
      format: this.format(),
      pixelRatio: this.ratio(),
      selectionOnly: this.selectionOnly(),
      background: this.background(),
      forceLight: this.forceLight(),
    });
    this.busy.set(false);
  }
}
