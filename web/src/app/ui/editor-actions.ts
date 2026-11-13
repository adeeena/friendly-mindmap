import { Injectable, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { APP_INFO } from '../app-info';
import { descendantsOf, topLevel } from '../core/commands';
import { BoardValidationError } from '../core/validate';
import { EditorStore } from '../editor/editor-store';
import { MessageKey, t } from '../i18n';
import { checklistOf, checklistToMarkdown, checklistToPlainText } from '../io/checklist-export';
import { ImageExportOptions, downloadBlob, downloadUrl, renderImage } from '../io/image-export';
import { toMermaid } from '../io/mermaid';
import { MissingAttachmentsError, importBoardFile, safeFileName, toNativeJson, toNativeZip } from '../io/native-format';
import { boundsOf } from '../layout/layout';
import { BoardSession } from '../persistence/board-session';
import { AttachmentPolicyError } from '../persistence/board-repository';
import { WorkspaceSession } from '../persistence/workspace-session';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'warning' | 'error';
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
  private readonly workspace = inject(WorkspaceSession);
  private readonly toaster = inject(Toaster);
  private readonly document = inject(DOCUMENT);
  private saving: Promise<void> | null = null;

  hasAttachments(): boolean {
    return Object.values(this.store.doc().nodes).some((n) => n.attachments?.length);
  }

  /** Ctrl/Cmd+S: durable local save of the current edits, then (when logged in) an acknowledged cloud sync. Never downloads a file. */
  saveWorkspace(): Promise<void> {
    this.saving ??= this.performSave().finally(() => { this.saving = null; });
    return this.saving;
  }

  private async performSave(): Promise<void> {
    const local = await this.session.saveNow();
    if (!local.ok || local.revision === null) {
      this.toaster.show(t('toast.saveFailed'), 'error', 8000);
      return;
    }
    if (!this.workspace.account()) return;
    const before = this.workspace.recoveryMessage();
    const result = await this.workspace.syncBoardNow(local.boardId, local.revision);
    const recovery = this.workspace.recoveryMessage();
    if (result === 'acknowledged' && recovery && recovery !== before) {
      this.toaster.show(t('toast.cloudConflict'), 'warning', 8000);
    } else if (result === 'acknowledged') {
      return;
    } else if (result === 'auth-required') {
      this.toaster.show(t('toast.cloudAuth'), 'error', 8000);
    } else if (result === 'conflict' || result === 'policy-error' || result === 'error' || result === 'attachment-unavailable') {
      this.toaster.show(t('toast.cloudAttention'), 'error', 8000);
    } else {
      this.toaster.show(t('toast.cloudPending'), 'warning', 6000);
    }
  }

  /** Bytes for an export: cached, or fetched from the cloud when this device has not downloaded them yet. */
  private async attachmentBytes(meta: { id: string; name: string; mime: string; size: number }): Promise<Blob | null> {
    let blob: Blob | null = null;
    try { blob = await this.session.getAttachment(meta.id); } catch { blob = null; }
    if (blob || !this.workspace.account()) return blob;
    const doc = this.store.doc();
    const node = Object.values(doc.nodes).find((n) => n.attachments?.some((a) => a.id === meta.id));
    if (!node) return null;
    if (await this.workspace.fetchAttachment(doc.id, meta, node.id) !== 'ok') return null;
    try { return await this.session.getAttachment(meta.id); } catch { return null; }
  }

  async saveFile(withAttachments: boolean): Promise<void> {
    const doc = this.store.doc();
    const name = safeFileName(doc.name);
    try {
      if (withAttachments) {
        const zip = await toNativeZip(doc, this.store.camera(), (meta) => this.attachmentBytes(meta));
        downloadBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), `${name}.bmm.zip`);
      } else {
        downloadBlob(new Blob([toNativeJson(doc, this.store.camera())], { type: 'application/json' }), `${name}.bmm.json`);
      }
    } catch (error) {
      if (!(error instanceof MissingAttachmentsError)) throw error;
      this.toaster.show(t('toast.exportMissing', { names: error.names.join(', ') }), 'error', 10000);
      return;
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
      const imported = await importBoardFile(file);
      const { dropped } = await this.session.importBoard(imported);
      this.toaster.show(t('toast.loaded', { name: imported.board.doc.name }));
      if (dropped.length) this.toaster.show(t('toast.importDropped', { names: dropped.join(', ') }), 'warning', 10000);
    } catch (e) {
      const msg =
        e instanceof AttachmentPolicyError && e.violation === 'size' ? t('error.attachTooLarge', { name: file.name })
          : e instanceof AttachmentPolicyError && e.violation === 'count' ? t('error.attachCount')
          : e instanceof BoardValidationError && e.key
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
    const identity = this.session.repository.workspace;
    const workspace = identity.kind === 'guest' ? 'guest' : identity.accountId;
    void this.session.flush().then(() => {
      const url = `/print/${encodeURIComponent(this.store.doc().id)}/${encodeURIComponent(id)}?w=${encodeURIComponent(workspace)}`;
      this.document.defaultView?.open(url, '_blank', 'noopener');
    });
  }
}
