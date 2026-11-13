import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SwUpdate } from '@angular/service-worker';
import { BoardSession } from './persistence/board-session';

/** Never swaps application versions underneath an unsaved editor or pending outbox. */
@Injectable({ providedIn: 'root' })
export class AppUpdates {
  private readonly updates = inject(SwUpdate, { optional: true });
  private readonly boards = inject(BoardSession);
  readonly available = signal(false);
  readonly failed = signal(false);

  constructor() {
    if (!this.updates?.isEnabled) return;
    this.updates.versionUpdates.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event.type === 'VERSION_READY') this.available.set(true);
      if (event.type === 'VERSION_INSTALLATION_FAILED') this.failed.set(true);
    });
    this.updates.unrecoverable.pipe(takeUntilDestroyed()).subscribe(() => this.failed.set(true));
    const view = inject(DOCUMENT).defaultView;
    const check = () => { void this.updates?.checkForUpdate().catch(() => this.failed.set(true)); };
    view?.addEventListener('focus', check);
    inject(DestroyRef).onDestroy(() => view?.removeEventListener('focus', check));
  }

  async prepareReload(): Promise<boolean> {
    try {
      await this.boards.flush();
      if (this.boards.status() === 'error' || this.boards.repository.localDurability !== 'persistent') return false;
      return true;
    } catch {
      this.failed.set(true);
      return false;
    }
  }
}
