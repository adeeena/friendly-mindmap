import { DestroyRef, Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { MessageKey, Msg, t } from '../i18n';
import { AccountBoardCache } from './account-cache';
import { AuthClient, AuthSession, CloudRequestError } from './auth-client';
import { BoardRepository } from './board-repository';
import { BoardSession } from './board-session';
import { lockableRepository } from './locked-repository';
import { AccountSync, SyncState, TransferEvent } from './account-sync';
import { AttachmentMeta } from '../core/model';
import { Preferences as PreferenceChanges } from '../../../../shared/preferences';
import { SettingsService } from '../settings.service';
import { AccountPreferences } from './account-preferences';
import { CloudBoardClient } from './cloud-board-client';
import { CloudHistoryClient, HistoryDetail, HistoryPage } from './history-client';
import { WorkspaceAuthState } from './workspace-auth-state';

export const CLOUD_BOARD_CLIENT = new InjectionToken<CloudBoardClient>('CLOUD_BOARD_CLIENT', {
  providedIn: 'root', factory: () => new CloudBoardClient(),
});

export type HistoryFailure = 'offline' | 'auth' | 'conflict' | 'policy' | 'missing' | 'unsynced' | 'failed';
export type HistoryResult<T> = { ok: true; value: T } | { ok: false; reason: HistoryFailure };
const historyFailure = (reason: HistoryFailure): { ok: false; reason: HistoryFailure } => ({ ok: false, reason });

export const CLOUD_HISTORY_CLIENT = new InjectionToken<CloudHistoryClient>('CLOUD_HISTORY_CLIENT', {
  providedIn: 'root', factory: () => new CloudHistoryClient(),
});

/** Authentication chooses a repository; guest documents are never uploaded or merged. */
@Injectable({ providedIn: 'root' })
export class WorkspaceSession {
  private readonly auth = inject(AuthClient);
  private readonly boards = inject(BoardSession);
  private readonly cloud = inject(CLOUD_BOARD_CLIENT);
  private readonly historyClient = inject(CLOUD_HISTORY_CLIENT);
  readonly account = signal<AuthSession['account'] | null>(null);
  readonly busy = signal(false);
  readonly error = signal<MessageKey | null>(null);
  readonly verified = signal(false);
  readonly syncState = signal<SyncState>('pending');
  readonly recoveryMessage = signal<Msg | null>(null);
  readonly syncError = computed<MessageKey | null>(() => {
    if (!this.account()) return null;
    switch (this.syncState()) {
      case 'retrying': return 'sync.retrying';
      case 'auth-required': return 'sync.authRequired';
      case 'conflict': return 'sync.conflict';
      case 'policy-error': return 'sync.policy';
      case 'attachment-unavailable': return 'sync.attachmentUnavailable';
      case 'error': return 'sync.failed';
      default: return null;
    }
  });
  private session: AuthSession | null = null;
  private guest: BoardRepository | null = null;
  private privateCache: { cache: AccountBoardCache; lock(): void } | null = null;
  private generation = 0;
  private sync: AccountSync | null = null;
  private prefs: AccountPreferences | null = null;
  private readonly settings = inject(SettingsService);
  private readonly authState = new WorkspaceAuthState(localStorage);
  private revoking: Promise<void> | null = null;
  private revocationTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingLock = false;
  private activatingAccount: string | null = null;
  private destroyed = false;
  private lifecycleSetup = false;
  private readonly reconnect = () => { void this.retryRevocations(); };
  private readonly storageChanged = (event: StorageEvent) => {
    const id = this.activatingAccount ?? this.account()?.id;
    if (!id) return;
    try {
      if (this.authState.isLockEvent(event, id) && this.authState.locked(id)) this.requestLock();
    } catch { this.error.set('auth.cacheUnavailable'); this.requestLock(); }
  };

  private requestLock(): void {
    this.verified.set(false);
    this.pendingLock = true;
    this.generation++;
    if (!this.busy()) void this.leaveAccount(false);
  }

  private finishTransition(): void {
    this.busy.set(false);
    this.activatingAccount = null;
    if (this.pendingLock && this.account()) void this.leaveAccount(false);
    else this.pendingLock = false;
  }

  async retryRevocations(current?: AuthSession | null): Promise<void> {
    if (this.destroyed) return;
    if (this.revoking) {
      await this.revoking;
      if (current) await this.retryRevocations(current);
      return;
    }
    if (this.revocationTimer !== null) clearTimeout(this.revocationTimer);
    this.revocationTimer = null;
    const notice = () => {
      if (!this.destroyed && (!this.error() || this.error() === 'auth.revokeOnReconnect')) this.error.set('auth.revokeOnReconnect');
    };
    this.revoking = (async () => {
      try {
        const pending = this.authState.pending();
        if (!pending.length) return;
        const session = current === undefined ? await this.auth.current(AbortSignal.timeout(15_000)) : current;
        if (!session) { notice(); return; }
        const matching = pending.filter((target) => target.accountId === session.account.id)
          .sort((a, b) => Number(a.sessionId === session.sessionId) - Number(b.sessionId === session.sessionId));
        for (const target of matching) {
          await this.auth.logout(session, target.sessionId);
          this.authState.acknowledge(target);
        }
        if (this.authState.pending().length) notice();
        else if (this.error() === 'auth.revokeOnReconnect') this.error.set(null);
      } catch {
        notice();
      }
    })().finally(() => {
      this.revoking = null;
      if (this.destroyed) return;
      try {
        if (this.authState.pending().length) {
          this.revocationTimer = setTimeout(() => { this.revocationTimer = null; void this.retryRevocations(); }, 30_000);
        }
      } catch { this.error.set('auth.cacheUnavailable'); }
    });
    await this.revoking;
  }

  /** Accounts whose private cache is stored on this device (never includes any password or token). */
  cachedAccounts(): AuthSession['account'][] {
    try { return this.authState.cachedAccounts(); } catch { return []; }
  }

  cacheSummary(accountId: string): Promise<{ pending: number; boards: number }> {
    return AccountBoardCache.summarize(accountId);
  }

  /**
   * Explicitly deletes one account's private device cache. Unsynchronized work in it is lost, so the UI
   * must warn first. The active account can only be discarded after logging out.
   */
  async discardCachedAccount(accountId: string): Promise<boolean> {
    if (this.account()?.id === accountId || this.activatingAccount === accountId) return false;
    try {
      // Lock first so any other tab using this account returns to the guest workspace before deletion.
      this.authState.lock(accountId);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await AccountBoardCache.discard(accountId);
      this.authState.unregisterCached(accountId);
      return true;
    } catch {
      this.error.set('auth.cacheUnavailable');
      return false;
    }
  }

  retrySync(): void { this.sync?.retry(); }

  readonly transfers = signal<Record<string, TransferEvent>>({});

  /** Which of a board's files are held on this device and which are still waiting for upload. */
  async attachmentAvailability(boardId: string): Promise<{ cached: Set<string>; queued: Set<string> }> {
    const generation = this.generation;
    const cached = new Set(await this.boards.repository.listAttachmentIds(boardId));
    const queued = new Set(this.privateCache ? await this.privateCache.cache.pendingAttachmentIds(boardId) : []);
    if (generation !== this.generation) throw new Error('Workspace changed during attachment lookup');
    return { cached, queued };
  }

  async fetchAttachment(boardId: string, meta: AttachmentMeta, nodeId: string): Promise<'ok' | 'offline' | 'unavailable' | 'auth' | 'failed' | 'cancelled'> {
    const sync = this.sync;
    if (!sync) return 'unavailable';
    try {
      await sync.fetchAttachment(boardId, meta, nodeId);
      return 'ok';
    } catch (error) {
      if (error instanceof CloudRequestError) {
        if (error.status === 401 || error.status === 403) return 'auth';
        return error.status === 404 || error.status === 410 ? 'unavailable' : 'failed';
      }
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
      if (error instanceof TypeError || (error instanceof Error && ['TimeoutError', 'NetworkError'].includes(error.name))) return 'offline';
      return 'failed';
    }
  }

  /** Cloud history needs a verified, matching live session and a connection; it is never served from caches. */
  private async historyCall<T>(operation: (session: AuthSession, signal: AbortSignal) => Promise<T>): Promise<HistoryResult<T>> {
    const generation = this.generation;
    const account = this.account();
    if (!account) return historyFailure('auth');
    const signal = AbortSignal.timeout(60_000);
    try {
      const session = await this.auth.current(signal);
      if (!session || session.account.id.toLowerCase() !== account.id.toLowerCase() || generation !== this.generation) {
        return historyFailure('auth');
      }
      return { ok: true, value: await operation(session, signal) };
    } catch (error) {
      if (error instanceof CloudRequestError) {
        if (error.status === 401 || error.status === 403) return historyFailure('auth');
        if (error.status === 404 || error.status === 410) return historyFailure('missing');
        if (error.status === 409) return historyFailure('conflict');
        if (error.status === 413 || error.status === 422) return historyFailure('policy');
        // 429/5xx (including the service worker's offline 504) mean the service cannot be reached right now.
        return historyFailure(error.status === 429 || error.status >= 500 ? 'offline' : 'failed');
      }
      if (error instanceof TypeError || (error instanceof Error && ['TimeoutError', 'NetworkError', 'AbortError'].includes(error.name))) {
        return historyFailure('offline');
      }
      return historyFailure('failed');
    }
  }

  listHistory(boardId: string, before?: string): Promise<HistoryResult<HistoryPage>> {
    return this.historyCall((session, signal) => this.historyClient.list(boardId, session, signal, before));
  }

  historyDetail(boardId: string, contentRevision: string): Promise<HistoryResult<HistoryDetail>> {
    return this.historyCall((session, signal) => this.historyClient.detail(boardId, contentRevision, session, signal));
  }

  /**
   * Restores a retained revision as a new revision. Local edits must be acknowledged first so the exact
   * server revision is known; the restored board then flows back through the normal refresh path.
   */
  async restoreHistory(boardId: string, contentRevision: string): Promise<HistoryResult<void>> {
    const local = await this.boards.saveNow();
    if (!local.ok || local.revision === null || local.boardId !== boardId) return historyFailure('unsynced');
    const acknowledged = await this.syncBoardNow(boardId, local.revision);
    if (acknowledged !== 'acknowledged') {
      return historyFailure(acknowledged === 'auth-required' ? 'auth' : acknowledged === 'retrying' ? 'offline' : 'unsynced');
    }
    const cached = await this.privateCache?.cache.syncBoard(boardId);
    const expected = cached?.serverRevision;
    if (!expected) return historyFailure('unsynced');
    const result = await this.historyCall((session, signal) =>
      this.historyClient.restore(boardId, contentRevision, expected, crypto.randomUUID(), session, signal));
    if (result.ok) await this.sync?.synchronize();
    return result;
  }

  cancelTransfer(attachmentId: string): void { this.sync?.cancelTransfer(attachmentId); }

  /** Requests an immediate synchronization and waits for the cloud to acknowledge that local revision. */
  async syncBoardNow(boardId: string, revision: number): Promise<'acknowledged' | SyncState> {
    const sync = this.sync;
    if (!sync) return 'pending';
    return sync.flushBoard(boardId, revision);
  }

  async dismissRecovery(): Promise<void> {
    const generation = this.generation;
    try {
      await this.privateCache?.cache.setMeta('syncNotice', null);
      if (generation === this.generation) this.recoveryMessage.set(null);
    } catch { if (generation === this.generation) this.error.set('auth.cacheUnavailable'); }
  }

  private startSync(cache: AccountBoardCache): void {
    const generation = this.generation;
    const sync = new AccountSync(cache, {
      current: (signal) => this.auth.current(signal),
      client: this.cloud,
      copyName: (name) => t('board.conflictCopy', { name }),
      recovered: (notice) => {
        if (generation !== this.generation) return;
        this.recoveryMessage.set({ key: notice.deletion ? 'sync.deleteConflict' : 'sync.recovered', params: { name: notice.name ?? '' } });
      },
      changed: async (change) => {
        if (generation === this.generation) await this.boards.remoteChanged(change);
      },
      transfer: (event) => {
        if (generation !== this.generation) return;
        this.transfers.update((current) => {
          const { [event.attachmentId]: _removed, ...rest } = current;
          return event.done ? rest : { ...rest, [event.attachmentId]: event };
        });
      },
      state: (state) => {
        if (generation !== this.generation) return;
        this.syncState.set(state);
        if (state === 'auth-required') {
          this.error.set('auth.sessionLocked');
          this.requestLock();
        }
      },
      verified: (session) => {
        if (generation !== this.generation) return;
        if (this.authState.locked(session.account.id)) { this.requestLock(); return; }
        this.session = session;
        this.verified.set(true);
        try { this.authState.remember(session); }
        catch { this.error.set('auth.cacheUnavailable'); }
        if (this.error() === 'auth.offline') this.error.set(null);
      },
    });
    this.sync = sync;
    this.syncState.set('pending');
    sync.start();
    this.startPreferences(cache, generation);
  }

  private async stopSync(): Promise<void> {
    const prefs = this.prefs;
    this.prefs = null;
    await prefs?.stop();
    await this.sync?.stop();
    this.sync = null;
  }

  /** Account appearance/language replace guest values only while that account's cache is open. */
  private startPreferences(cache: AccountBoardCache, generation: number): void {
    const prefs = new AccountPreferences(cache.accountId, cache, {
      current: (signal) => this.auth.current(signal),
      applied: (values) => { if (generation === this.generation && this.prefs === prefs) this.settings.applyAccountValues(values); },
    });
    this.prefs = prefs;
    const begin = (values: PreferenceChanges) => {
      if (generation !== this.generation || this.prefs !== prefs) return;
      this.settings.useGuest();
      this.settings.useAccount(values, (changes) => { void prefs.change(changes); });
      prefs.start();
    };
    prefs.effective().then(begin, () => begin({}));
  }

  async init(destroyRef: DestroyRef): Promise<void> {
    if (!this.lifecycleSetup) {
      this.lifecycleSetup = true;
      window.addEventListener('online', this.reconnect);
      window.addEventListener('focus', this.reconnect);
      window.addEventListener('storage', this.storageChanged);
      destroyRef.onDestroy(() => {
        this.destroyed = true;
        if (this.revocationTimer !== null) clearTimeout(this.revocationTimer);
        window.removeEventListener('online', this.reconnect);
        window.removeEventListener('focus', this.reconnect);
        window.removeEventListener('storage', this.storageChanged);
        this.generation++;
        this.privateCache?.lock();
        const cache = this.privateCache?.cache;
        void this.prefs?.stop();
        void (this.sync?.stop() ?? Promise.resolve()).then(() => cache?.close()).catch(() => this.error.set('auth.cacheUnavailable'));
      });
    }
    await this.boards.init(destroyRef);
    this.guest = this.boards.repository;
    this.busy.set(true);
    const generation = ++this.generation;
    try {
      const current = await this.auth.current();
      if (generation !== this.generation) return;
      await this.retryRevocations(current);
      if (!current) {
        const previous = this.authState.account();
        if (previous) { this.authState.lock(previous.id); this.error.set('auth.sessionLocked'); }
        return;
      }
      if (this.authState.locked(current.account.id)) return;
      await this.activate(current);
    } catch {
      if (generation === this.generation) {
        // A guest with no remembered account has nothing to warn about while the cloud is unreachable.
        let remembered = false;
        try { remembered = !!this.authState.account(); } catch { remembered = true; }
        this.error.set(remembered ? 'auth.unavailable' : null);
        try { if (this.authState.pending().length) this.error.set('auth.revokeOnReconnect'); }
        catch { this.error.set('auth.cacheUnavailable'); }
        await this.openOfflineCache();
      }
    } finally { this.finishTransition(); }
  }

  async login(username: string, password: string): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true);
    this.error.set(null);
    const generation = ++this.generation;
    try {
      const current = await this.auth.login(username, password);
      if (generation !== this.generation) return false;
      await this.retryRevocations(current);
      await this.activate(current);
      return true;
    } catch (error) {
      this.error.set(error instanceof CloudRequestError && error.status === 401 ? 'auth.invalid'
        : error instanceof CloudRequestError && error.status === 429 ? 'auth.throttled' : 'auth.unavailable');
      return false;
    } finally { this.finishTransition(); }
  }

  private async activate(current: AuthSession): Promise<void> {
    const generation = this.generation;
    const lockVersion = this.authState.lockVersion(current.account.id);
    this.activatingAccount = current.account.id;
    const previous = this.privateCache;
    const previousRepository = this.boards.repository;
    const cache = new AccountBoardCache(current.account.id, current.account.role);
    const locked = lockableRepository(cache);
    this.guest ??= this.boards.repository;
    const resume = await this.boards.prepareWorkspaceTransition();
    await this.stopSync();
    try {
      if (!(await cache.list()).length && !(await cache.pending(1)).length) {
        const signal = AbortSignal.timeout(60_000);
        for (const summary of await this.cloud.list(current, signal)) {
          if (summary.deletedAt !== null) continue;
          const remote = await this.cloud.load(summary.id, current, signal);
          if (remote) await cache.cacheRemote(remote.record, remote.revision);
        }
      }
      if (generation !== this.generation || this.authState.lockVersion(current.account.id) !== lockVersion) {
        throw new Error('Account was locked during activation');
      }
      await this.boards.switchRepository(locked.repository);
      if (generation !== this.generation || this.authState.lockVersion(current.account.id) !== lockVersion) {
        throw new Error('Account was locked during activation');
      }
      this.authState.unlock(current.account.id);
      this.authState.remember(current);
      previous?.lock();
      if (previous) await previous.cache.close();
      this.privateCache = { cache, lock: locked.lock };
      this.session = current;
      this.account.set(current.account);
      this.verified.set(true);
      this.recoveryMessage.set(null);
      this.transfers.set({});
      this.startSync(cache);
    } catch (error) {
      locked.lock();
      await cache.close();
      if (this.boards.repository !== previousRepository) await this.boards.switchRepository(previousRepository);
      resume();
      if (previous) this.startSync(previous.cache);
      throw error;
    }
  }

  private async openOfflineCache(): Promise<void> {
    const previousRepository = this.boards.repository;
    let resume: (() => void) | undefined;
    try {
      const account = this.authState.account();
      if (!account || this.authState.locked(account.id)) return;
      const generation = this.generation;
      this.activatingAccount = account.id;
      const cache = new AccountBoardCache(account.id, account.role);
      const locked = lockableRepository(cache);
      try {
        if (!(await cache.list()).length) { await cache.close(); return; }
        resume = await this.boards.prepareWorkspaceTransition();
        if (generation !== this.generation || this.authState.locked(account.id)) throw new Error('Offline account was locked');
        await this.boards.switchRepository(locked.repository);
        if (generation !== this.generation || this.authState.locked(account.id)) throw new Error('Offline account was locked');
        this.privateCache = { cache, lock: locked.lock };
        this.session = null;
        this.verified.set(false);
        this.account.set(account);
        this.error.set('auth.offline');
        this.startSync(cache);
      } catch (error) {
        locked.lock();
        await cache.close();
        if (this.boards.repository !== previousRepository) await this.boards.switchRepository(previousRepository);
        resume?.();
        throw error;
      }
    } catch { this.error.set('auth.cacheUnavailable'); }
  }

  async logout(): Promise<boolean> { return this.leaveAccount(true); }

  private async leaveAccount(explicit: boolean): Promise<boolean> {
    if (this.busy() || !this.account() || !this.guest) return false;
    this.busy.set(true);
    this.error.set(null);
    ++this.generation;
    const accountId = this.account()!.id;
    let resume: (() => void) | undefined;
    try {
      resume = await this.boards.prepareWorkspaceTransition();
      await this.stopSync();
      const target = this.session ? { accountId, sessionId: this.session.sessionId } : this.authState.session(accountId);
      if (explicit && target) this.authState.defer(target);
      this.authState.lock(accountId);
      this.authState.forget(accountId);
      await this.boards.switchRepository(this.guest);
      this.privateCache?.lock();
      await this.privateCache?.cache.close();
      this.privateCache = null;
      this.session = null;
      this.account.set(null);
      this.verified.set(false);
      this.syncState.set('pending');
      this.recoveryMessage.set(null);
      this.transfers.set({});
      this.settings.useGuest();
      this.pendingLock = false;
      this.error.set(explicit ? (target ? 'auth.revokeOnReconnect' : 'auth.revokeUnknown') : 'auth.sessionLocked');
      if (explicit) void this.retryRevocations();
      return true;
    } catch {
      resume?.();
      this.error.set('auth.logoutFailed');
      if (this.privateCache) this.startSync(this.privateCache.cache);
      return false;
    } finally { this.busy.set(false); }
  }
}
