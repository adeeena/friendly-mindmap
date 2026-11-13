import { ChangeDetectionStrategy, Component, DestroyRef, afterNextRender, inject, input, signal } from '@angular/core';
import { ChecklistData, checklistOf, checklistProgress } from '../io/checklist-export';
import { t } from '../i18n';
import { AccountBoardCache } from '../persistence/account-cache';
import { AuthClient } from '../persistence/auth-client';
import { BoardRepository } from '../persistence/board-repository';
import { IndexedDbBoardRepository } from '../persistence/indexeddb-repository';
import { migrateBoard } from '../persistence/migrations';
import { WorkspaceAuthState } from '../persistence/workspace-auth-state';

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
  /** Workspace that opened this print view: `guest` or an account id. */
  readonly w = input<string>('guest');
  protected readonly data = signal<ChecklistData | null>(null);
  protected readonly error = signal<string | null>(null);
  private readonly authState = new WorkspaceAuthState(localStorage);
  private readonly auth = inject(AuthClient);
  private accountId: string | null = null;

  constructor() {
    afterNextRender(() => void this.load());
    const onStorage = (event: StorageEvent) => {
      try {
        if (this.accountId && this.authState.isLockEvent(event, this.accountId) && this.authState.locked(this.accountId)) this.lock();
      } catch { this.lock(); }
    };
    window.addEventListener('storage', onStorage);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('storage', onStorage));
  }

  private lock(): void {
    this.data.set(null);
    this.error.set(t('print.locked'));
  }

  /** A private checklist is shown only for the unlocked account that opened it; guest checklists never need an account. */
  private async repository(): Promise<(BoardRepository & { close?(): Promise<void> }) | null> {
    const workspace = this.w();
    if (workspace === 'guest') return new IndexedDbBoardRepository();
    const account = this.authState.account();
    if (!account || account.id.toLowerCase() !== workspace.toLowerCase() || this.authState.locked(account.id)) return null;
    try {
      const session = await this.auth.current(AbortSignal.timeout(15_000));
      if (!session || session.account.id.toLowerCase() !== account.id.toLowerCase()) {
        // Same rule as the editor: an ended or different server session locks the cached account.
        this.authState.lock(account.id);
        return null;
      }
    } catch { /* offline: the unlocked cached account stays usable but unverified */ }
    if (this.authState.locked(account.id)) return null;
    this.accountId = account.id;
    return new AccountBoardCache(account.id, account.role);
  }

  private async load(): Promise<void> {
    let repository: Awaited<ReturnType<ChecklistPrint['repository']>> = null;
    try {
      repository = await this.repository();
      if (!repository) { this.lock(); return; }
      const rec = await repository.load(this.boardId());
      const c = rec ? checklistOf(migrateBoard(rec).doc, this.nodeId()) : null;
      if (!c) throw new Error();
      if (this.accountId && this.authState.locked(this.accountId)) { this.lock(); return; }
      this.data.set(c);
      document.title = t('print.title', { title: c.title });
      setTimeout(() => { if (this.data()) window.print(); }, 300);
    } catch {
      this.error.set(t('print.notFound'));
    } finally {
      await repository?.close?.();
    }
  }

  protected progress(c: ChecklistData): string {
    const p = checklistProgress(c);
    return t('node.ariaProgress', { done: p.done, total: p.total });
  }

  protected print(): void {
    try {
      if (this.accountId && this.authState.locked(this.accountId)) { this.lock(); return; }
    } catch { this.lock(); return; }
    window.print();
  }
}
