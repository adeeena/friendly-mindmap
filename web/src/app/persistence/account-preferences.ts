import {
  Preferences as PreferenceChanges, isLanguagePreference, isThemePreference,
} from '../../../../shared/preferences';
import { AuthSession, CloudRequestError } from './auth-client';

interface PreferenceStore {
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
}

interface Cached {
  values: PreferenceChanges;
  revision: string;
}

const CACHE_KEY = 'preferences';
const PENDING_KEY = 'preferencesPending';
const revisionPattern = /^(?:0|[1-9]\d{0,18})$/;

/** Keeps only known, valid fields so a newer server or tampered cache cannot inject values. */
export function validPreferences(value: unknown): PreferenceChanges {
  const out: PreferenceChanges = {};
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    if (isThemePreference(source['theme'])) out.theme = source['theme'];
    if (isLanguagePreference(source['language'])) out.language = source['language'];
  }
  return out;
}

export class PreferencesClient {
  private async request(session: AuthSession, signal: AbortSignal, init: RequestInit = {}): Promise<Cached> {
    const response = await fetch('/api/account/configuration', {
      ...init, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: { 'X-CSRF-Token': session.csrfToken, 'X-Session-Id': session.sessionId, ...init.headers },
    });
    if (!response.ok) {
      let code: string | undefined;
      try {
        const body: unknown = await response.json();
        const error = body && typeof body === 'object' ? (body as { error?: { code?: unknown } }).error : undefined;
        if (typeof error?.code === 'string') code = error.code;
      } catch { /* no structured error */ }
      throw new CloudRequestError(response.status, code);
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object') throw new Error('Invalid account configuration response');
    const { configuration, revision } = body as { configuration?: unknown; revision?: unknown };
    if (typeof revision !== 'string' || !revisionPattern.test(revision)) throw new Error('Invalid account configuration revision');
    return { values: validPreferences(configuration), revision };
  }

  load(session: AuthSession, signal: AbortSignal): Promise<Cached> {
    return this.request(session, signal);
  }

  patch(session: AuthSession, expectedRevision: string, changes: PreferenceChanges, signal: AbortSignal): Promise<Cached> {
    return this.request(session, signal, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision, changes }),
    });
  }
}

export interface PreferenceOptions {
  current(signal: AbortSignal): Promise<AuthSession | null>;
  applied(values: PreferenceChanges): void;
  client?: Pick<PreferencesClient, 'load' | 'patch'>;
  events?: EventTarget | null;
  channel?: BroadcastChannel | null;
}

/**
 * Account appearance/language: cached offline, queued per field and merged by the server so
 * concurrent changes to different fields never erase each other.
 */
export class AccountPreferences {
  private readonly client: Pick<PreferencesClient, 'load' | 'patch'>;
  private readonly events: EventTarget | null;
  private readonly channel: BroadcastChannel | null;
  private readonly controller = new AbortController();
  private running: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly wake = () => { void this.synchronize(); };
  private readonly message = () => { void this.restore(); };

  constructor(private readonly accountId: string, private readonly store: PreferenceStore, private readonly options: PreferenceOptions) {
    this.client = options.client ?? new PreferencesClient();
    this.events = options.events === undefined ? (typeof window === 'undefined' ? null : window) : options.events;
    this.channel = options.channel === undefined && typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(`better-mindmap-preferences:${accountId.toLowerCase()}`) : options.channel ?? null;
  }

  /** Cached account values with unsent local edits on top. */
  async effective(): Promise<PreferenceChanges> {
    const cached = await this.store.getMeta<Cached>(CACHE_KEY);
    const pending = await this.store.getMeta<unknown>(PENDING_KEY);
    return { ...validPreferences(cached?.values), ...validPreferences(pending) };
  }

  private async restore(): Promise<void> {
    if (this.stopped) return;
    try { this.options.applied(await this.effective()); } catch { /* cache unavailable: keep current values */ }
  }

  start(): void {
    this.events?.addEventListener('online', this.wake);
    this.events?.addEventListener('focus', this.wake);
    this.channel?.addEventListener('message', this.message);
    this.interval = setInterval(this.wake, 60_000);
    void this.synchronize();
  }

  /** Records a user edit durably before any network attempt. */
  change(changes: PreferenceChanges): Promise<void> {
    const saved = validPreferences(changes);
    this.queue = this.queue.then(async () => {
      const pending = validPreferences(await this.store.getMeta(PENDING_KEY));
      await this.store.setMeta(PENDING_KEY, { ...pending, ...saved });
      this.channel?.postMessage('changed');
      this.schedule(0);
    });
    return this.queue.catch(() => undefined);
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.synchronize(); }, delay);
  }

  synchronize(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.running ??= this.run().catch(() => { this.schedule(30_000); }).finally(() => { this.running = null; });
    return this.running;
  }

  private async run(): Promise<void> {
    await this.queue;
    for (let attempt = 0; attempt < 4; attempt++) {
      const signal = this.controller.signal;
      const session = await this.options.current(signal);
      if (!session || session.account.id.toLowerCase() !== this.accountId.toLowerCase()) return;
      const remote = await this.client.load(session, signal);
      const sent = validPreferences(await this.store.getMeta(PENDING_KEY));
      const changes = Object.fromEntries(Object.entries(sent).filter(([key, value]) =>
        remote.values[key as keyof PreferenceChanges] !== value)) as PreferenceChanges;
      let latest = remote;
      if (Object.keys(changes).length) {
        try { latest = await this.client.patch(session, remote.revision, changes, signal); }
        catch (error) {
          if (error instanceof CloudRequestError && error.status === 409 && error.code === 'REVISION_CONFLICT') continue;
          throw error;
        }
      }
      if (this.stopped) return;
      await this.store.setMeta(CACHE_KEY, latest);
      // Drop only fields that were still unchanged while the request ran.
      const after = validPreferences(await this.store.getMeta(PENDING_KEY));
      const remaining = Object.fromEntries(Object.entries(after).filter(([key, value]) =>
        sent[key as keyof PreferenceChanges] !== value)) as PreferenceChanges;
      await this.store.setMeta(PENDING_KEY, remaining);
      this.options.applied({ ...latest.values, ...remaining });
      if (Object.keys(remaining).length) this.schedule(0);
      return;
    }
    this.schedule(5_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.interval !== null) clearInterval(this.interval);
    this.events?.removeEventListener('online', this.wake);
    this.events?.removeEventListener('focus', this.wake);
    this.channel?.removeEventListener('message', this.message);
    this.channel?.close();
    await this.running;
  }
}
