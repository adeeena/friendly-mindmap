import { Injectable, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { APP_INFO } from '../app-info';
import { createId } from '../core/model';
import { descendantsOf, topLevel } from '../core/commands';
import { BoardValidationError } from '../core/validate';
import { EditorStore } from '../editor/editor-store';
import { MessageKey, t } from '../i18n';
import { checklistOf, checklistToMarkdown, checklistToPlainText } from '../io/checklist-export';
import { ImageExportOptions, downloadBlob, downloadUrl, renderImage } from '../io/image-export';
import { toMermaid } from '../io/mermaid';
import { importBoardFile, safeFileName, toNativeJson, toNativeZip } from '../io/native-format';
import { boundsOf } from '../layout/layout';
import { BoardSession } from '../persistence/board-session';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

@Injectable({ providedIn: 'root' })
export class Toaster {
  readonly toasts = signal<Toast[]>([]);
  private next = 0;

  show(text: string, kind: Toast['kind'] = 'info', ms = 5000): void {
    const t = { id: ++this.next, text, kind };
    this.toasts.update((l) => [...l, t]);
    setTimeout(() => this.dismiss(t.id), ms);
  }

  dismiss(id: number): void {
    this.toasts.update((l) => l.filter((t) => t.id !== id));
  }
}

/** File and export actions shared by commands, toolbar and dialogs. */
@Injectable({ providedIn: 'root' })
export class EditorActions {
  private readonly store = inject(EditorStore);
  private readonly session = inject(BoardSession);
  private readonly toaster = inject(Toaster);
  private readonly document = inject(DOCUMENT);

  hasAttachments(): boolean {
    return Object.values(this.store.doc().nodes).some((n) => n.attachments?.length);
  }

  async saveFile(withAttachments: boolean): Promise<void> {
    const doc = this.store.doc();
    const name = safeFileName(doc.name);
    if (withAttachments) {
      const zip = await toNativeZip(doc, this.store.camera(), (id) => this.session.getAttachment(id));
      downloadBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), `${name}.bmm.zip`);
    } else {
      downloadBlob(new Blob([toNativeJson(doc, this.store.camera())], { type: 'application/json' }), `${name}.bmm.json`);
    }
    this.toaster.show(t('toast.savedFile'));
  }

  pickAndLoad(): void {
    const input = this.document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.zip,application/json,application/zip';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void this.loadFile(file);
    };
    input.click();
  }

  async loadFile(file: File): Promise<void> {
    try {
      const { board, files } = await importBoardFile(file);
      const doc = { ...board.doc, id: createId() };
      const id = await this.session.create(doc.name, doc);
      for (const f of files) await this.session.repository.putAttachment(id, f.meta, f.blob);
      this.store.camera.set(board.camera);
      this.toaster.show(t('toast.loaded', { name: doc.name }));
    } catch (e) {
      const msg =
        e instanceof BoardValidationError && e.key
          ? t(e.key as MessageKey, { app: APP_INFO.name })
          : t('error.loadFailed');
      this.toaster.show(msg, 'error', 8000);
    }
  }

  mermaid(): string {
    return toMermaid(this.store.doc());
  }

  downloadMermaid(): void {
    downloadBlob(new Blob([this.mermaid()], { type: 'text/plain' }), `${safeFileName(this.store.doc().name)}.mmd`);
  }

  async copyText(text: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toaster.show(t('toast.copied', { label }));
    } catch {
      this.toaster.show(t('toast.noClipboard'), 'error');
    }
  }

  async exportImage(opts: Omit<ImageExportOptions, 'include'> & { selectionOnly: boolean }): Promise<void> {
    const world = this.document.querySelector<HTMLElement>('.bm-world');
    if (!world) return;
    let include: Set<string> | null = null;
    if (opts.selectionOnly && this.store.selectedIds().length) {
      const doc = this.store.doc();
      const roots = topLevel(doc, this.store.selectedIds());
      include = new Set(roots.flatMap((id) => [id, ...descendantsOf(doc, id)]));
    }
    const rects = [...this.store.rects()].filter(([id]) => !include || include.has(id)).map(([, r]) => r);
    const bounds = boundsOf(rects);
    if (!bounds) {
      this.toaster.show(t('toast.nothingToExport'), 'error');
      return;
    }
    try {
      const url = await renderImage(world, bounds, { ...opts, include });
      downloadUrl(url, `${safeFileName(this.store.doc().name)}.${opts.format}`);
    } catch {
      this.toaster.show(t('toast.exportFailed'), 'error');
    }
  }

  checklistFor(id = this.store.primaryId()) {
    return id ? checklistOf(this.store.doc(), id) : null;
  }

  async copyChecklist(kind: 'markdown' | 'text'): Promise<void> {
    const c = this.checklistFor();
    if (!c) return;
    await this.copyText(kind === 'markdown' ? checklistToMarkdown(c) : checklistToPlainText(c), t('export.tabChecklist'));
  }

  canShare(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  }

  async shareChecklist(): Promise<void> {
    const c = this.checklistFor();
    if (!c || !this.canShare()) return;
    try {
      await navigator.share({ title: c.title, text: checklistToPlainText(c) });
    } catch {
      /* user cancelled */
    }
  }

  printChecklist(): void {
    const id = this.store.primaryId();
    if (!id) return;
    void this.session.flush().then(() => {
      const url = `/print/${encodeURIComponent(this.store.doc().id)}/${encodeURIComponent(id)}`;
      this.document.defaultView?.open(url, '_blank', 'noopener');
    });
  }
}
