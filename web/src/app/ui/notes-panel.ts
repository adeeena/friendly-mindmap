import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { AttachmentMeta, RichDoc, emptyDoc } from '../core/model';
import { removeAttachment } from '../core/commands';
import { EditorStore, newTxn } from '../editor/editor-store';
import { t } from '../i18n';
import { TransferEvent } from '../persistence/account-sync';
import { BoardSession } from '../persistence/board-session';
import { WorkspaceSession } from '../persistence/workspace-session';
import { Icon } from './icon';
import { RichEditor } from './rich-editor';

@Component({
  selector: 'bm-notes-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RichEditor, Icon],
  host: {
    class: 'bm-notes bm-panel',
    role: 'complementary',
    'aria-labelledby': 'bm-notes-title',
    '(keydown.escape)': 'close($event)',
  },
  template: `
    <div class="bm-notes-head">
      <h2 id="bm-notes-title">{{ node() ? t('notes.titleFor', { title: title() }) : t('notes.title') }}</h2>
      <button type="button" class="bm-button" [attr.aria-label]="t('notes.close')" (click)="close()">
        <bm-icon name="close" />
      </button>
    </div>
    @if (node(); as n) {
      @for (key of [n.id]; track key) {
        <bm-rich-editor
          class="bm-note-editor"
          [ariaLabel]="t('notes.note')"
          [autofocus]="false"
          [content]="n.note ?? empty"
          (changed)="onNote($event)"
          (blurred)="store.sealHistory()"
        />
      }
      <section class="bm-attachments" aria-labelledby="bm-att-title">
        <h3 id="bm-att-title">{{ t('notes.attachments') }}</h3>
        @if (error()) {
          <p class="bm-error" role="alert">{{ error() }}</p>
        }
        <ul>
          @for (a of n.attachments ?? []; track a.id) {
            <li class="bm-att" [attr.data-status]="status(a)">
              @if (thumbs()[a.id]; as src) {
                <img [src]="src" alt="" class="bm-thumb" />
              } @else {
                <bm-icon name="attach" />
              }
              <span class="bm-att-name">{{ a.name }}</span>
              <span class="bm-att-size">{{ size(a.size) }}</span>
              @if (transfers()[a.id]; as tr) {
                <progress class="bm-att-progress" [attr.aria-label]="t('notes.progress', { name: a.name })" [max]="tr.total || 1" [value]="tr.loaded"></progress>
                <span class="bm-att-state" role="status">{{ t(tr.kind === 'upload' ? 'notes.uploading' : 'notes.downloading', { percent: percent(tr) }) }}</span>
                <button type="button" class="bm-button" [attr.aria-label]="t('notes.cancelTransfer', { name: a.name })" (click)="cancel(a, tr.kind)">
                  <bm-icon name="close" />
                </button>
              } @else {
                @switch (status(a)) {
                  @case ('queued') {
                    <span class="bm-att-state" role="status">{{ t('notes.queued') }}</span>
                    @if (!store.readOnly()) {
                      <button type="button" class="bm-button" [attr.aria-label]="t('notes.cancelTransfer', { name: a.name })" (click)="cancel(a, 'upload')">
                        <bm-icon name="close" />
                      </button>
                    }
                  }
                  @case ('cloud') { <span class="bm-att-state">{{ t('notes.cloudOnly') }}</span> }
                  @case ('missing') { <span class="bm-att-state">{{ t('notes.missingLocal') }}</span> }
                }
                <button type="button" class="bm-button" [attr.aria-label]="t('notes.open', { name: a.name })" (click)="open(a)">
                  <bm-icon name="export" />
                </button>
                <button type="button" class="bm-button" [attr.aria-label]="t('notes.download', { name: a.name })" (click)="download(a)">
                  <bm-icon name="download" />
                </button>
                @if (!store.readOnly()) {
                  <button type="button" class="bm-button" [attr.aria-label]="t('notes.remove', { name: a.name })" (click)="remove(a)">
                    <bm-icon name="trash" />
                  </button>
                }
              }
            </li>
          } @empty {
            <li class="bm-muted">{{ t('notes.none') }}</li>
          }
        </ul>
        @if (!store.readOnly()) {
          <label class="bm-button bm-file-btn">
            <bm-icon name="attach" /> {{ t('notes.attach') }}
            <input type="file" multiple class="visually-hidden" (change)="pick($event)" />
          </label>
        }
      </section>
    } @else {
      <p class="bm-muted">{{ t('notes.selectOne') }}</p>
    }
  `,
})
export class NotesPanel {
  protected readonly t = t;
  protected readonly store = inject(EditorStore);
  private readonly session = inject(BoardSession);
  private readonly workspace = inject(WorkspaceSession);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly empty: RichDoc = emptyDoc();
  protected readonly error = signal<string | null>(null);
  protected readonly thumbs = signal<Record<string, string>>({});
  protected readonly transfers = this.workspace.transfers;
  private readonly availability = signal<{ cached: Set<string>; queued: Set<string> } | null>(null);
  private availabilityToken = 0;
  private txn = newTxn('note');
  private urls: string[] = [];

  protected readonly node = computed(() => {
    const ids = this.store.selectedIds();
    return ids.length === 1 ? this.store.doc().nodes[ids[0]] : null;
  });
  protected readonly title = computed(() => {
    const n = this.node();
    return n ? this.store.label(n.id) : '';
  });

  constructor() {
    effect(() => {
      const n = this.node();
      this.txn = newTxn('note');
      this.error.set(null);
      void this.loadThumbs(n?.attachments ?? []);
    });
    effect(() => {
      this.node();
      this.transfers();
      this.store.docVersion();
      untracked(() => void this.refreshAvailability());
    });
    inject(DestroyRef).onDestroy(() => this.urls.forEach((u) => URL.revokeObjectURL(u)));
    queueMicrotask(() => this.host.nativeElement.querySelector<HTMLElement>('[contenteditable], button')?.focus());
  }

  private async refreshAvailability(): Promise<void> {
    const token = ++this.availabilityToken;
    try {
      const value = await this.workspace.attachmentAvailability(this.store.doc().id);
      if (token === this.availabilityToken) this.availability.set(value);
    } catch {
      if (token === this.availabilityToken) this.availability.set(null);
    }
  }

  /** Where a file's bytes are: held here, waiting for upload, only in the cloud, or lost from this device. */
  protected status(a: AttachmentMeta): 'local' | 'queued' | 'cloud' | 'missing' {
    const known = this.availability();
    if (!known || known.cached.has(a.id)) return known?.queued.has(a.id) ? 'queued' : 'local';
    return this.workspace.account() ? 'cloud' : 'missing';
  }

  protected percent(tr: TransferEvent): number {
    return tr.total > 0 ? Math.min(100, Math.floor((tr.loaded / tr.total) * 100)) : 0;
  }

  /** Cancelling an upload removes the reference first so no newer snapshot can need the abandoned file. */
  protected async cancel(a: AttachmentMeta, kind: 'upload' | 'download'): Promise<void> {
    if (kind === 'upload') {
      this.remove(a);
      await this.session.flush();
    }
    this.workspace.cancelTransfer(a.id);
    await this.refreshAvailability();
  }

  private async loadThumbs(atts: AttachmentMeta[]): Promise<void> {
    const out: Record<string, string> = {};
    for (const a of atts) {
      if (!a.mime.startsWith('image/') || a.mime === 'image/svg+xml') continue;
      let blob: Blob | null = null;
      try { blob = await this.session.getAttachment(a.id); } catch { /* bytes unavailable on this device */ }
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      this.urls.push(url);
      out[a.id] = url;
    }
    this.thumbs.set(out);
  }

  protected onNote(doc: RichDoc): void {
    const n = this.node();
    if (n) this.store.setNote(n.id, doc, this.txn);
  }

  protected close(e?: Event): void {
    e?.stopPropagation();
    this.store.notesOpen.set(false);
  }

  protected size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  protected async pick(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const n = this.node();
    if (!n || !input.files) return;
    const errors: string[] = [];
    for (const f of Array.from(input.files)) {
      const r = await this.session.attach(n.id, f);
      if (!r.ok) errors.push(r.reason);
    }
    this.error.set(errors.length ? errors.join(' ') : null);
    input.value = '';
  }

  private async blobUrl(a: AttachmentMeta): Promise<string | null> {
    let blob: Blob | null = null;
    try { blob = await this.session.getAttachment(a.id); } catch { /* fall through to a cloud download or an explicit error */ }
    if (!blob) {
      blob = await this.fetchMissing(a);
      if (!blob) return null;
    }
    // Serve unknown or active types as downloads to avoid executing content in the app origin.
    const safe = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain|audio\/|video\/)/.test(a.mime);
    const url = URL.createObjectURL(safe ? blob : new Blob([blob], { type: 'application/octet-stream' }));
    this.urls.push(url);
    return url;
  }

  /** Downloads a cloud-only file once, reporting unavailability instead of pretending it exists. */
  private async fetchMissing(a: AttachmentMeta): Promise<Blob | null> {
    const n = this.node();
    if (!n || !this.workspace.account()) {
      this.error.set(t('notes.unavailable', { name: a.name }));
      return null;
    }
    const result = await this.workspace.fetchAttachment(this.store.doc().id, a, n.id);
    await this.refreshAvailability();
    if (result === 'cancelled') return null;
    if (result !== 'ok') {
      this.error.set(t(result === 'offline' ? 'notes.offlineUnavailable' : result === 'auth' ? 'notes.fetchAuth'
        : result === 'unavailable' ? 'notes.unavailable' : 'notes.fetchFailed', { name: a.name }));
      return null;
    }
    this.error.set(null);
    let blob: Blob | null = null;
    try { blob = await this.session.getAttachment(a.id); } catch { blob = null; }
    if (!blob) this.error.set(t('notes.fetchFailed', { name: a.name }));
    else void this.loadThumbs(n.attachments ?? []);
    return blob;
  }

  protected async open(a: AttachmentMeta): Promise<void> {
    const url = await this.blobUrl(a);
    if (url) window.open(url, '_blank', 'noopener');
  }

  protected async download(a: AttachmentMeta): Promise<void> {
    const url = await this.blobUrl(a);
    if (!url) return;
    const link = document.createElement('a');
    link.href = url;
    link.download = a.name;
    link.click();
  }

  protected remove(a: AttachmentMeta): void {
    const n = this.node();
    if (n) this.store.mutate((d) => removeAttachment(d, n.id, a.id), { label: 'Remove attachment' });
  }
}
