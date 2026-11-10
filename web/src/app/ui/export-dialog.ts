import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { APP_INFO } from '../app-info';
import { EditorStore } from '../editor/editor-store';
import { MessageKey, t } from '../i18n';
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
      <h2 id="bm-export-title">{{ t('export.title') }}</h2>
      <button type="button" class="bm-button" [attr.aria-label]="t('common.close')" (click)="ref.close()"><bm-icon name="close" /></button>
    </div>
    <div class="bm-tabs" role="tablist" [attr.aria-label]="t('export.type')">
      @for (tab of tabs(); track tab.id) {
        <button
          type="button"
          role="tab"
          class="bm-button"
          [id]="'bm-tab-' + tab.id"
          [attr.aria-selected]="current() === tab.id"
          [attr.aria-controls]="'bm-panel-' + tab.id"
          [attr.tabindex]="current() === tab.id ? 0 : -1"
          (click)="current.set(tab.id)"
          (keydown)="tabKey($event)"
        >
          {{ t(tab.label) }}
        </button>
      }
    </div>
    <section role="tabpanel" [id]="'bm-panel-' + current()" [attr.aria-labelledby]="'bm-tab-' + current()" class="bm-tabpanel">
      @switch (current()) {
        @case ('file') {
          <p>{{ t('export.fileIntro', { app: appName }) }}</p>
          <label class="bm-check-label">
            <input type="checkbox" [checked]="withAttachments()" (change)="withAttachments.set($any($event.target).checked)" [disabled]="!actions.hasAttachments()" />
            {{ t('export.embed') }}
          </label>
          <div class="bm-dialog-actions">
            <button type="button" class="bm-button bm-primary" cdkFocusInitial (click)="save()"><bm-icon name="save" /> {{ t('export.saveFile') }}</button>
          </div>
        }
        @case ('mermaid') {
          <p class="bm-warning" role="note">
            {{ t('export.mermaidWarn') }}
          </p>
          <label for="bm-mermaid-text" class="visually-hidden">{{ t('export.mermaidText') }}</label>
          <textarea id="bm-mermaid-text" class="bm-code" readonly rows="10" [value]="mermaid()"></textarea>
          <div class="bm-dialog-actions">
            <button type="button" class="bm-button" (click)="actions.copyText(mermaid(), t('export.tabMermaid'))"><bm-icon name="copy" /> {{ t('export.copy') }}</button>
            <button type="button" class="bm-button bm-primary" (click)="actions.downloadMermaid()"><bm-icon name="download" /> {{ t('export.downloadMmd') }}</button>
          </div>
        }
        @case ('image') {
          <fieldset>
            <legend>{{ t('export.format') }}</legend>
            <label><input type="radio" name="fmt" [checked]="format() === 'png'" (change)="format.set('png')" /> PNG</label>
            <label><input type="radio" name="fmt" [checked]="format() === 'svg'" (change)="format.set('svg')" /> SVG</label>
          </fieldset>
          @if (format() === 'png') {
            <fieldset>
              <legend>{{ t('export.resolution') }}</legend>
              <label><input type="radio" name="res" [checked]="ratio() === 1" (change)="ratio.set(1)" /> 1x</label>
              <label><input type="radio" name="res" [checked]="ratio() === 2" (change)="ratio.set(2)" /> 2x</label>
            </fieldset>
          }
          <fieldset>
            <legend>{{ t('export.content') }}</legend>
            <label><input type="radio" name="scope" [checked]="!selectionOnly()" (change)="selectionOnly.set(false)" /> {{ t('export.wholeBoard') }}</label>
            <label>
              <input type="radio" name="scope" [checked]="selectionOnly()" [disabled]="!hasSelection()" (change)="selectionOnly.set(true)" />
              {{ t('export.selection') }}
            </label>
          </fieldset>
          <label class="bm-check-label"><input type="checkbox" [checked]="forceLight()" (change)="forceLight.set($any($event.target).checked)" /> {{ t('export.lightTheme') }}</label>
          <label class="bm-check-label"><input type="checkbox" [checked]="background()" (change)="background.set($any($event.target).checked)" /> {{ t('export.background') }}</label>
          <div class="bm-dialog-actions">
            <button type="button" class="bm-button bm-primary" [disabled]="busy()" (click)="image()"><bm-icon name="download" /> {{ t('export.exportImage') }}</button>
          </div>
        }
        @case ('checklist') {
          @if (checklist(); as c) {
            <p>{{ t('export.checklistIntro', { title: c.title, count: c.items.length }) }}</p>
            <div class="bm-dialog-actions bm-wrap">
              <button type="button" class="bm-button" (click)="actions.copyChecklist('markdown')"><bm-icon name="copy" /> {{ t('export.markdown') }}</button>
              <button type="button" class="bm-button" (click)="actions.copyChecklist('text')"><bm-icon name="copy" /> {{ t('export.plainText') }}</button>
              @if (actions.canShare()) {
                <button type="button" class="bm-button" (click)="actions.shareChecklist()"><bm-icon name="share" /> {{ t('export.share') }}</button>
              }
              <button type="button" class="bm-button" (click)="actions.printChecklist()"><bm-icon name="print" /> {{ t('export.print') }}</button>
            </div>
          }
        }
      }
    </section>
  `,
})
export class ExportDialog {
  protected readonly t = t;
  protected readonly appName = APP_INFO.name;
  protected readonly ref = inject(DialogRef);
  protected readonly actions = inject(EditorActions);
  private readonly store = inject(EditorStore);
  private readonly data = inject<{ tab?: ExportTab } | null>(DIALOG_DATA, { optional: true });

  protected readonly checklist = computed(() => this.actions.checklistFor());
  protected readonly tabs = computed(() => {
    const list: { id: ExportTab; label: MessageKey }[] = [
      { id: 'file', label: 'export.tabFile' },
      { id: 'mermaid', label: 'export.tabMermaid' },
      { id: 'image', label: 'export.tabImage' },
    ];
    if (this.checklist()) list.push({ id: 'checklist', label: 'export.tabChecklist' });
    return list;
  });
  protected readonly current = signal<ExportTab>(this.data?.tab ?? 'file');
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
    const ids = this.tabs().map((x) => x.id);
    const i = ids.indexOf(this.current());
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + ids.length) % ids.length;
    else return;
    e.preventDefault();
    this.current.set(ids[next]);
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
