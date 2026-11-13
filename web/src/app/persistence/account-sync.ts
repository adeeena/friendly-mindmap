import { AccountBoardCache, CloudRecoveryNotice, OfflineAttachmentUnavailableError, PendingChangesError, PendingMutation } from './account-cache';
import { AttachmentMeta } from '../core/model';
import { AuthSession, CloudRequestError } from './auth-client';
import { CloudBoardClient, CloudProtocolError } from './cloud-board-client';
import { migrateBoard } from './migrations';

export type SyncState = 'pending' | 'syncing' | 'idle' | 'retrying' | 'auth-required' | 'conflict' | 'policy-error' | 'attachment-unavailable' | 'error';
export type SyncClient = Pick<CloudBoardClient, 'stage' | 'commit' | 'upload' | 'list' | 'load' | 'download'>;

interface SyncOptions {
  current(signal: AbortSignal): Promise<AuthSession | null>;
  state(state: SyncState): void;
  verified(session: AuthSession): void;
  client?: SyncClient;
  copyName?(name: string): string;
  recovered?(notice: CloudRecoveryNotice): void;
  changed?(change: { id: string; revision: number; deleted: boolean }): Promise<void>;
  transfer?(event: TransferEvent): void;
  locks?: Pick<LockManager, 'request'> | null;
  events?: EventTarget | null;
  channel?: BroadcastChannel | null;
}

class SyncOwnershipLost extends Error {}
class TransferCancelled extends Error {}

export interface TransferEvent {
  attachmentId: string;
  kind: 'upload' | 'download';
  loaded: number;
  total: number;
  done?: boolean;
}
const paused = (state: SyncState) => ['auth-required', 'conflict', 'policy-error', 'attachment-unavailable', 'error'].includes(state);

/** Replays only frozen durable snapshots; no editor state is read or acknowledged here. */
export class AccountSync {
  private readonly owner = crypto.randomUUID();
  private readonly controller = new AbortController();
  private readonly client: SyncClient;
  private readonly locks: Pick<LockManager, 'request'> | null;
  private readonly events: EventTarget | null;
  private readonly channel: BroadcastChannel | null;
  private unsubscribe: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private started = false;
  private attempts = 0;
  private readonly transfers = new Map<string, AbortController>();
  private status: SyncState = 'pending';
  private readonly reconnect = () => { if (!paused(this.status) || this.status === 'auth-required') this.retry(); };
  private readonly changed = () => {
    this.channel?.postMessage({ type: 'pending' });
    this.wake();
  };
  private readonly message = (event: MessageEvent<unknown>) => {
    if (event.data && typeof event.data === 'object' && 'type' in event.data && event.data.type === 'pending') this.wake();
  };

  constructor(private readonly cache: AccountBoardCache, private readonly options: SyncOptions) {
    this.client = options.client ?? new CloudBoardClient();
    this.locks = options.locks === undefined ? globalThis.navigator?.locks ?? null : options.locks;
    this.events = options.events === undefined ? (typeof window === 'undefined' ? null : window) : options.events;
    this.channel = options.channel === undefined && typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(`better-mindmap-sync:${cache.accountId.toLowerCase()}`) : options.channel ?? null;
  }

  private setState(state: SyncState): void {
    this.status = state;
    if (!this.stopped) this.options.state(state);
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.unsubscribe = this.cache.onPendingChange(this.changed);
    this.events?.addEventListener('online', this.reconnect);
    this.events?.addEventListener('focus', this.reconnect);
    this.channel?.addEventListener('message', this.message);
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.stopped || !this.started || paused(this.status)) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.synchronize(); }, delay);
  }

  private wake(): void {
    if (this.stopped || paused(this.status)) return;
    if (this.status === 'idle') this.setState('pending');
    // Local writes cannot collapse the backoff for an unavailable server.
    if (this.status !== 'retrying') this.schedule(0);
  }

  retry(): void {
    if (this.stopped) return;
    this.attempts = 0;
    this.setState('pending');
    this.schedule(0);
  }

  synchronize(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.running = this.run().catch((error: unknown) => {
      if (this.stopped) return;
      if (error instanceof SyncOwnershipLost) { this.setState('pending'); return; }
      if (error instanceof PendingChangesError) { this.setState('pending'); return; }
      if (error instanceof OfflineAttachmentUnavailableError) { this.setState('attachment-unavailable'); return; }
      if (error instanceof CloudRequestError) {
        if (error.status === 401 || error.status === 403) this.setState('auth-required');
        else if ([404, 409, 410].includes(error.status)) this.setState('conflict');
        else if (error.status === 413 || error.status === 422) this.setState('policy-error');
        else if (error.status === 429 || error.status >= 500) this.setState('retrying');
        else this.setState('error');
      } else if (error instanceof TypeError || (error instanceof Error && ['TimeoutError', 'NetworkError', 'AbortError'].includes(error.name))) {
        this.setState('retrying');
      } else this.setState('error');
    }).finally(() => {
      this.running = null;
      if (this.status === 'retrying') {
        const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.attempts++, 6));
        this.schedule(delay + Math.floor(Math.random() * Math.min(delay / 4, 1000)));
      } else this.schedule(this.status === 'pending' ? 1000 : 15_000);
    });
    return this.running;
  }

  private async run(): Promise<void> {
    if (this.locks) {
      await this.locks.request(`better-mindmap-sync:${this.cache.accountId.toLowerCase()}`,
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => { if (lock) await this.replay(); else this.setState('pending'); });
    } else await this.replay();
  }

  private async replay(): Promise<void> {
    if (!await this.cache.syncLease(this.owner, Date.now(), 15_000)) { this.setState('pending'); return; }
    let leaseError: unknown;
    let renewing: Promise<void> = Promise.resolve();
    const renew = async () => {
      if (!await this.cache.syncLease(this.owner, Date.now(), 15_000)) throw new SyncOwnershipLost();
    };
    const heartbeat = setInterval(() => {
      renewing = renewing.then(renew).catch((error: unknown) => { leaseError = error; });
    }, 5000);
    const check = async () => {
      if (leaseError) throw leaseError;
      this.controller.signal.throwIfAborted();
      await renew();
      this.controller.signal.throwIfAborted();
    };
    let failedMutation: number | null = null;
    try {
      this.setState('syncing');
      let refreshed = false;
      const notice = await this.cache.getMeta<unknown>('syncNotice');
      if (notice !== null && notice !== undefined) {
        if (typeof notice !== 'object' || !('name' in notice) || (notice.name !== null && typeof notice.name !== 'string') ||
            !('deletion' in notice) || typeof notice.deletion !== 'boolean') throw new Error('Invalid cloud recovery notice');
        this.options.recovered?.({ name: notice.name, deletion: notice.deletion });
      }
      replay: for (;;) {
        await check();
        const session = await this.options.current(AbortSignal.any([this.controller.signal, AbortSignal.timeout(60_000)]));
        await check();
        if (!session || session.account.id.toLowerCase() !== this.cache.accountId.toLowerCase()) {
          this.setState('auth-required');
          return;
        }
        this.options.verified(session);
        const pending = (await this.cache.pending(1))[0];
        await check();
        if (!pending) {
          if (!refreshed) {
            await this.refresh(session, check);
            refreshed = true;
            continue;
          }
          this.attempts = 0;
          this.setState('idle');
          return;
        }
        const operation = await this.cache.beginMutation(pending.id);
        failedMutation = operation.id;
        if (operation.record) {
          const board = migrateBoard(operation.record);
          const cached = await this.cache.syncBoard(operation.boardId);
          const base = cached?.base ? migrateBoard(cached.base).doc : null;
          const existing = new Set(Object.values(base?.nodes ?? {}).flatMap((node) => (node.attachments ?? []).map((meta) => meta.id)));
          let staged = false;
          for (const node of Object.values(board.doc.nodes)) {
            for (const meta of node.attachments ?? []) {
              await check();
              if (existing.has(meta.id) || await this.cache.attachmentReady(operation.boardId, meta.id)) continue;
              if (operation.expectedRevision === null && !staged) {
                await this.client.stage(operation.boardId, session, this.controller.signal);
                staged = true;
              }
              await check();
              const source = await this.cache.attachmentSource(operation.boardId, meta.id);
              if (source) {
                let stream: ReadableStream<Uint8Array<ArrayBuffer>>;
                try { stream = await this.client.download(source.boardId, source.id, meta, session, this.controller.signal); }
                catch (error) {
                  if (error instanceof CloudRequestError && [404, 410].includes(error.status)) throw new OfflineAttachmentUnavailableError();
                  throw error;
                }
                await this.cache.receiveAttachment(operation.boardId, meta, node.id, stream, this.controller.signal);
              }
              const transfer = new AbortController();
              this.transfers.set(meta.id, transfer);
              this.options.transfer?.({ attachmentId: meta.id, kind: 'upload', loaded: 0, total: meta.size });
              try {
                await this.client.upload(operation.boardId, node.id, meta, session,
                  AbortSignal.any([this.controller.signal, transfer.signal]),
                  (offset, length) => this.cache.attachmentPart(operation.boardId, meta.id, offset, length), check,
                  (loaded) => this.options.transfer?.({ attachmentId: meta.id, kind: 'upload', loaded, total: meta.size }));
              } catch (error) {
                if (transfer.signal.aborted && !this.controller.signal.aborted) throw new TransferCancelled();
                if (error instanceof CloudRequestError && [404, 410].includes(error.status) &&
                    ['NOT_FOUND', 'BOARD_DELETED'].includes(error.code ?? '')) {
                  await check();
                  await this.recover(operation, session, check);
                  failedMutation = null;
                  continue replay;
                }
                throw error;
              } finally {
                this.transfers.delete(meta.id);
                this.options.transfer?.({ attachmentId: meta.id, kind: 'upload', loaded: 0, total: 0, done: true });
              }
              await check();
              await this.cache.markAttachmentReady(operation.boardId, meta.id);
            }
          }
        }
        await check();
        let revision: string;
        try { revision = await this.client.commit(operation, session, this.controller.signal); }
        catch (error) {
          if (error instanceof CloudRequestError && ['REVISION_CONFLICT', 'BOARD_DELETED', 'NOT_FOUND'].includes(error.code ?? '') &&
              [404, 409, 410].includes(error.status)) {
            await check();
            await this.recover(operation, session, check);
            failedMutation = null;
            continue;
          }
          throw error;
        }
        await check();
        await this.cache.acknowledge(operation.id, revision);
        failedMutation = null;
      }

    } catch (error) {
      if (error instanceof TransferCancelled && failedMutation !== null) {
        // The user removed the reference first, so a newer queued snapshot normally supersedes this frozen one.
        await this.cache.requeueRejectedMutation(failedMutation);
        throw new PendingChangesError();
      }
      if (!this.stopped && failedMutation !== null && (error instanceof OfflineAttachmentUnavailableError ||
          (error instanceof CloudRequestError && [413, 422].includes(error.status)))) {
        // A definitive rejection has no receipt/effects; later corrections may safely replace this snapshot.
        if (await this.cache.requeueRejectedMutation(failedMutation)) throw new PendingChangesError();
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      await renewing;
      await this.cache.releaseSyncLease(this.owner);
    }
  }

  private async recover(operation: PendingMutation, session: AuthSession, check: () => Promise<void>): Promise<void> {
    const remote = await this.client.load(operation.boardId, session, this.controller.signal);
    await check();
    const current = await this.cache.syncBoard(operation.boardId);
    if (!current) throw new Error('Conflict has no local snapshot');
    let change;
    if (remote) {
      change = await this.cache.reconcileRemote(remote, current.revision, true, this.options.copyName ?? ((name) => name + ' conflict copy'));
    } else {
      const tombstone = (await this.client.list(session, this.controller.signal)).find((board) => board.id === operation.boardId && board.deletedAt !== null);
      if (!tombstone) throw new CloudProtocolError('A missing board has no deletion tombstone');
      await check();
      change = await this.cache.reconcileRemote({ id: tombstone.id, revision: tombstone.revision, deleted: true },
        current.revision, true, this.options.copyName ?? ((name) => name + ' conflict copy'));
    }
    await check();
    if (change.notice) this.options.recovered?.(change.notice);
    await this.options.changed?.(change);
  }

  private async refresh(session: AuthSession, check: () => Promise<void>): Promise<void> {
    const remote = await this.client.list(session, this.controller.signal);
    for (const summary of remote) {
      await check();
      const current = await this.cache.syncBoard(summary.id);
      if (current?.serverRevision && BigInt(current.serverRevision) >= BigInt(summary.revision)) continue;
      // An in-flight operation may already have committed: retry its receipt before interpreting a changed remote revision.
      if (await this.cache.hasPending(summary.id)) continue;
      const board = summary.deletedAt === null ? await this.client.load(summary.id, session, this.controller.signal) : null;
      await check();
      if (!board && summary.deletedAt === null) continue;
      const change = await this.cache.reconcileRemote(board ?? { id: summary.id, revision: summary.revision, deleted: true },
        current?.revision ?? null, false, this.options.copyName ?? ((name) => name + ' conflict copy'));
      await check();
      await this.options.changed?.(change);
    }
  }

  /** Cancels an active upload/download; the caller must already have removed a cancelled upload's reference. */
  cancelTransfer(attachmentId: string): void {
    this.transfers.get(attachmentId)?.abort();
  }

  get state(): SyncState { return this.status; }

  /**
   * Waits until the cloud has acknowledged this local revision (board and any attachments are committed
   * before acknowledgement), or reports why that cannot happen now.
   */
  async flushBoard(boardId: string, sequence: number, timeoutMs = 30_000): Promise<'acknowledged' | SyncState> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.synchronize();
      // A paused or stopped coordinator (e.g. the account was locked) may already have closed its cache.
      if (this.status === 'auth-required') return 'auth-required';
      if (this.stopped) return 'pending';
      let acknowledged = false;
      try {
        const board = await this.cache.syncBoard(boardId);
        acknowledged = !!board && board.acknowledgedSequence >= sequence && !(await this.cache.hasPending(boardId));
      } catch {
        return this.state === 'auth-required' ? 'auth-required' : 'pending';
      }
      if (acknowledged) return 'acknowledged';
      if (paused(this.status) || this.status === 'retrying') return this.status;
      if (Date.now() >= deadline) return this.status === 'idle' ? 'pending' : this.status;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  /** Downloads a cloud file that was never cached on this device into the private account cache. */
  async fetchAttachment(boardId: string, meta: AttachmentMeta, nodeId: string): Promise<void> {
    if (this.stopped) throw new Error('Synchronization is stopped');
    if (this.transfers.has(meta.id)) throw new Error('Attachment transfer is already active');
    const transfer = new AbortController();
    this.transfers.set(meta.id, transfer);
    const signal = AbortSignal.any([this.controller.signal, transfer.signal]);
    this.options.transfer?.({ attachmentId: meta.id, kind: 'download', loaded: 0, total: meta.size });
    try {
      const session = await this.options.current(AbortSignal.any([signal, AbortSignal.timeout(60_000)]));
      if (!session || session.account.id.toLowerCase() !== this.cache.accountId.toLowerCase()) throw new CloudRequestError(401);
      this.options.verified(session);
      const source = await this.cache.attachmentSource(boardId, meta.id);
      const stream = await this.client.download(source?.boardId ?? boardId, source?.id ?? meta.id, meta, session, signal);
      let loaded = 0;
      const counted = stream.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
        transform: (chunk, controller) => {
          loaded += chunk.byteLength;
          this.options.transfer?.({ attachmentId: meta.id, kind: 'download', loaded, total: meta.size });
          controller.enqueue(chunk);
        },
      }));
      await this.cache.receiveAttachment(boardId, meta, nodeId, counted, signal, { serverReady: !source });
    } finally {
      this.transfers.delete(meta.id);
      this.options.transfer?.({ attachmentId: meta.id, kind: 'download', loaded: 0, total: 0, done: true });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    if (this.timer !== null) clearTimeout(this.timer);
    this.unsubscribe?.();
    this.events?.removeEventListener('online', this.reconnect);
    this.events?.removeEventListener('focus', this.reconnect);
    this.channel?.close();
    await this.running;
  }
}
