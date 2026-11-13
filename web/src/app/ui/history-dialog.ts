import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { Dialog, DialogRef } from '@angular/cdk/dialog';
import { EditorStore } from '../editor/editor-store';
import { MessageKey, language, t } from '../i18n';
import { HistoryAttachment, HistoryDetail, HistoryItem } from '../persistence/history-client';
import { HistoryFailure, WorkspaceSession } from '../persistence/workspace-session';
import { confirmDialog } from './board-dialogs';
import { Toaster } from './editor-actions';
import { Icon } from './icon';

const FAILURE: Record<HistoryFailure, MessageKey> = {
  offline: 'history.offline',
  auth: 'history.login',
  conflict: 'history.conflict',
  policy: 'history.policy',
  missing: 'history.missing',
  unsynced: 'history.unsynced',
  failed: 'history.failed',
};

/** Browse, inspect and restore retained cloud revisions of the open board; history is never served offline. */
@Component({
  selector: 'bm-history-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'bm-dialog bm-panel bm-history' },
  template: `
    <div class="bm-dialog-head">
      <h2 id="bm-history-title">{{ t('history.title') }}</h2>
      <button type="button" class="bm-button" [attr.aria-label]="t('common.close')" (click)="ref.close()"><bm-icon name="close" /></button>
    </div>
    <p class="bm-muted">{{ t('history.intro') }}</p>
    @if (workspace.account()?.role === 'basic') {
      <p class="bm-muted">{{ t('history.basicLimit') }}</p>
    }
    @if (failure(); as key) {
      <p class="bm-error" role="alert">{{ t(key) }}</p>
    }
    @if (loading()) {
      <p role="status">{{ t('common.loading') }}</p>
    }
    <ul class="bm-history-list" [attr.aria-label]="t('history.list')">
      @for (item of items(); track item.contentRevision) {
        <li class="bm-history-item" [class.current]="item.current">
          <button
            type="button"
            class="bm-history-open"
            [attr.aria-pressed]="selected()?.contentRevision === item.contentRevision"
            [attr.aria-label]="t('history.inspect', { n: item.contentRevision, when: when(item.createdAt) })"
            (click)="inspect(item)"
          >
            <span class="bm-history-title">{{ t('history.revision', { n: item.contentRevision }) }}</span>
            <span class="bm-muted">{{ when(item.createdAt) }} · {{ item.name }}</span>
            @if (item.current) { <span class="bm-history-badge">{{ t('history.current') }}</span> }
          </button>
          <button
            type="button"
            class="bm-button"
            [disabled]="item.current || busy()"
            [attr.aria-label]="t('history.restoreRevision', { n: item.contentRevision })"
            (click)="restore(item)"
          >
            <bm-icon name="undo" /> {{ t('history.restore') }}
          </button>
        </li>
      } @empty {
        @if (!loading() && !failure()) { <li class="bm-muted">{{ t('history.empty') }}</li> }
      }
    </ul>
    @if (nextBefore()) {
      <button type="button" class="bm-button" [disabled]="loading()" (click)="loadMore()">{{ t('history.showOlder') }}</button>
    }
    @if (detail(); as d) {
      <section class="bm-history-detail" aria-labelledby="bm-history-detail-title">
        <h3 id="bm-history-detail-title">{{ t('history.revision', { n: d.contentRevision }) }}</h3>
        <p>{{ t('history.nodes', { n: nodeCount(d) }) }}</p>
        <h4>{{ t('notes.attachments') }}</h4>
        <ul>
          @for (a of d.attachments; track a.id) {
            <li class="bm-history-file">
              <span class="bm-att-name">{{ a.name }}</span>
              <span class="bm-muted">{{ fileState(a) }}</span>
            </li>
          } @empty {
            <li class="bm-muted">{{ t('history.noAttachments') }}</li>
          }
        </ul>
      </section>
    }
  `,
})
export class HistoryDialog implements OnInit {
  protected readonly t = t;
  protected readonly ref = inject(DialogRef);
  protected readonly workspace = inject(WorkspaceSession);
  private readonly store = inject(EditorStore);
  private readonly dialog = inject(Dialog);
  private readonly toaster = inject(Toaster);
  private readonly boardId = this.store.doc().id;
  protected readonly items = signal<HistoryItem[]>([]);
  protected readonly nextBefore = signal<string | null>(null);
  protected readonly selected = signal<HistoryItem | null>(null);
  protected readonly detail = signal<HistoryDetail | null>(null);
  protected readonly failure = signal<MessageKey | null>(null);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  private cachedFiles = new Set<string>();

  ngOnInit(): void { void this.load(); }

  protected when(ms: number): string {
    return new Intl.DateTimeFormat(language(), { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
  }

  protected nodeCount(d: HistoryDetail): number {
    return Object.keys(d.doc.nodes).length;
  }

  protected fileState(a: HistoryAttachment): string {
    if (!a.available) return t('history.fileGone');
    return this.cachedFiles.has(a.id) ? t('history.fileDevice') : t('history.fileCloud');
  }

  private async load(before?: string): Promise<void> {
    this.loading.set(true);
    this.failure.set(null);
    const result = await this.workspace.listHistory(this.boardId, before);
    this.loading.set(false);
    if (!result.ok) { this.failure.set(FAILURE[result.reason]); return; }
    this.items.update((current) => (before ? [...current, ...result.value.items] : result.value.items));
    this.nextBefore.set(result.value.nextBefore);
  }

  protected loadMore(): void {
    const before = this.nextBefore();
    if (before) void this.load(before);
  }

  protected async inspect(item: HistoryItem): Promise<void> {
    this.selected.set(item);
    this.failure.set(null);
    const result = await this.workspace.historyDetail(this.boardId, item.contentRevision);
    if (!result.ok) { this.detail.set(null); this.failure.set(FAILURE[result.reason]); return; }
    try { this.cachedFiles = (await this.workspace.attachmentAvailability(this.boardId)).cached; }
    catch { this.cachedFiles = new Set(); }
    this.detail.set(result.value);
  }

  protected async restore(item: HistoryItem): Promise<void> {
    const ok = await confirmDialog(this.dialog, {
      title: t('history.confirmTitle', { n: item.contentRevision }),
      message: t('history.confirmMessage'),
      confirm: t('history.restore'),
    });
    if (!ok) return;
    this.busy.set(true);
    this.failure.set(null);
    const result = await this.workspace.restoreHistory(this.boardId, item.contentRevision);
    this.busy.set(false);
    if (!result.ok) {
      this.failure.set(FAILURE[result.reason]);
      // A concurrent change or policy failure leaves the list stale; refresh what can be offered.
      if (result.reason === 'conflict') await this.load();
      return;
    }
    this.toaster.show(t('history.restored', { n: item.contentRevision }));
    this.ref.close();
  }
}
