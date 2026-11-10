import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, signal } from '@angular/core';
import { AttachmentMeta, RichDoc, emptyDoc } from '../core/model';
import { removeAttachment } from '../core/commands';
import { EditorStore, newTxn } from '../editor/editor-store';
import { BoardSession } from '../persistence/board-session';
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
      <h2 id="bm-notes-title">Notes{{ node() ? ': ' + title() : '' }}</h2>
      <button type="button" class="bm-button" aria-label="Close notes" (click)="close()">
        <bm-icon name="close" />
      </button>
    </div>
    @if (node(); as n) {
      @for (key of [n.id]; track key) {
        <bm-rich-editor
          class="bm-note-editor"
          ariaLabel="Note"
          [autofocus]="false"
          [content]="n.note ?? empty"
          (changed)="onNote($event)"
          (blurred)="store.sealHistory()"
        />
      }
      <section class="bm-attachments" aria-labelledby="bm-att-title">
        <h3 id="bm-att-title">Attachments</h3>
        @if (error()) {
          <p class="bm-error" role="alert">{{ error() }}</p>
        }
        <ul>
          @for (a of n.attachments ?? []; track a.id) {
            <li class="bm-att">
              @if (thumbs()[a.id]; as src) {
                <img [src]="src" alt="" class="bm-thumb" />
              } @else {
                <bm-icon name="attach" />
              }
              <span class="bm-att-name">{{ a.name }}</span>
              <span class="bm-att-size">{{ size(a.size) }}</span>
              <button type="button" class="bm-button" [attr.aria-label]="'Open ' + a.name" (click)="open(a)">
                <bm-icon name="export" />
              </button>
              <button type="button" class="bm-button" [attr.aria-label]="'Download ' + a.name" (click)="download(a)">
                <bm-icon name="download" />
              </button>
              @if (!store.readOnly()) {
                <button type="button" class="bm-button" [attr.aria-label]="'Remove ' + a.name" (click)="remove(a)">
                  <bm-icon name="trash" />
                </button>
              }
            </li>
          } @empty {
            <li class="bm-muted">No attachments. Drop files on a node or use the button below.</li>
          }
        </ul>
        @if (!store.readOnly()) {
          <label class="bm-button bm-file-btn">
            <bm-icon name="attach" /> Attach files
            <input type="file" multiple class="visually-hidden" (change)="pick($event)" />
          </label>
        }
      </section>
    } @else {
      <p class="bm-muted">Select a single node to see its note.</p>
    }
  `,
})
export class NotesPanel {
  protected readonly store = inject(EditorStore);
  private readonly session = inject(BoardSession);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly empty: RichDoc = emptyDoc();
  protected readonly error = signal<string | null>(null);
  protected readonly thumbs = signal<Record<string, string>>({});
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
    inject(DestroyRef).onDestroy(() => this.urls.forEach((u) => URL.revokeObjectURL(u)));
    queueMicrotask(() => this.host.nativeElement.querySelector<HTMLElement>('[contenteditable], button')?.focus());
  }

  private async loadThumbs(atts: AttachmentMeta[]): Promise<void> {
    const out: Record<string, string> = {};
    for (const a of atts) {
      if (!a.mime.startsWith('image/') || a.mime === 'image/svg+xml') continue;
      const blob = await this.session.getAttachment(a.id);
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
    const blob = await this.session.getAttachment(a.id);
    if (!blob) {
      this.error.set(`“${a.name}” is not available on this device.`);
      return null;
    }
    // Serve unknown or active types as downloads to avoid executing content in the app origin.
    const safe = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain|audio\/|video\/)/.test(a.mime);
    const url = URL.createObjectURL(safe ? blob : new Blob([blob], { type: 'application/octet-stream' }));
    this.urls.push(url);
    return url;
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
