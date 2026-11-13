import { AuthSession, cachedAccount } from './auth-client';

const ACCOUNT_KEY = 'better-mindmap-last-account';
const SESSION_KEY = 'better-mindmap-last-session';
const CACHED_KEY = 'better-mindmap-cached-accounts';
const LOCK_PREFIX = 'better-mindmap-account-lock:';
const REVOCATION_PREFIX = 'better-mindmap-revoke:';
const LEGACY_LOCK_KEY = 'better-mindmap-locked-accounts';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionIdentity { accountId: string; sessionId: string }

function identity(value: unknown): SessionIdentity {
  if (!value || typeof value !== 'object' || !('accountId' in value) || !('sessionId' in value) ||
      typeof value.accountId !== 'string' || !uuid.test(value.accountId) ||
      typeof value.sessionId !== 'string' || !uuid.test(value.sessionId)) throw new Error('Invalid stored session identity');
  return { accountId: value.accountId, sessionId: value.sessionId };
}

/** Stores identities only: cookies, passwords and CSRF tokens never enter persistent storage. */
export class WorkspaceAuthState {
  constructor(private readonly storage: Storage) {}

  account(): AuthSession['account'] | null {
    const raw = this.storage.getItem(ACCOUNT_KEY);
    return raw === null ? null : cachedAccount(JSON.parse(raw));
  }

  session(accountId: string): SessionIdentity | null {
    const raw = this.storage.getItem(SESSION_KEY);
    if (raw === null) return null;
    const value = identity(JSON.parse(raw));
    return value.accountId === accountId ? value : null;
  }

  remember(session: AuthSession): void {
    const previous = this.account();
    if (previous && previous.id !== session.account.id) this.lock(previous.id);
    this.storage.setItem(SESSION_KEY, JSON.stringify({ accountId: session.account.id, sessionId: session.sessionId }));
    this.storage.setItem(ACCOUNT_KEY, JSON.stringify(session.account));
    this.registerCached(session.account);
  }

  /** Non-secret list of accounts whose private cache exists on this device, for explicit discard. */
  cachedAccounts(): AuthSession['account'][] {
    const raw = this.storage.getItem(CACHED_KEY);
    const value: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error('Invalid cached account list');
    return value.map((entry) => cachedAccount(entry));
  }

  registerCached(account: AuthSession['account']): void {
    const others = this.cachedAccounts().filter((entry) => entry.id !== account.id);
    this.storage.setItem(CACHED_KEY, JSON.stringify([...others, account]));
  }

  unregisterCached(accountId: string): void {
    const remaining = this.cachedAccounts().filter((entry) => entry.id !== accountId);
    this.storage.setItem(CACHED_KEY, JSON.stringify(remaining));
    this.unlock(accountId);
    if (this.account()?.id === accountId) this.forget(accountId);
  }

  forget(accountId: string): void {
    if (this.account()?.id === accountId) {
      this.storage.removeItem(ACCOUNT_KEY);
      this.storage.removeItem(SESSION_KEY);
    }
  }

  private legacyLocks(): string[] {
    const value: unknown = JSON.parse(this.storage.getItem(LEGACY_LOCK_KEY) ?? '[]');
    if (!Array.isArray(value) || !value.every((id) => typeof id === 'string')) throw new Error('Invalid account lock state');
    return value;
  }

  locked(accountId: string): boolean {
    return this.storage.getItem(LOCK_PREFIX + accountId) !== null || this.legacyLocks().includes(accountId);
  }

  lockVersion(accountId: string): string | null {
    return this.storage.getItem(LOCK_PREFIX + accountId) ?? (this.legacyLocks().includes(accountId) ? 'legacy' : null);
  }

  lock(accountId: string): void {
    this.storage.setItem(LOCK_PREFIX + accountId, crypto.randomUUID());
  }

  unlock(accountId: string): void {
    const legacy = this.legacyLocks();
    if (legacy.includes(accountId)) this.storage.setItem(LEGACY_LOCK_KEY, JSON.stringify(legacy.filter((id) => id !== accountId)));
    this.storage.removeItem(LOCK_PREFIX + accountId);
  }

  isLockEvent(event: StorageEvent, accountId: string): boolean {
    return event.storageArea === this.storage &&
      (event.key === null || event.key === LOCK_PREFIX + accountId || event.key === LEGACY_LOCK_KEY);
  }

  defer(session: SessionIdentity): void {
    this.storage.setItem(REVOCATION_PREFIX + session.sessionId, JSON.stringify(session));
  }

  pending(): SessionIdentity[] {
    const values: SessionIdentity[] = [];
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index);
      if (!key?.startsWith(REVOCATION_PREFIX)) continue;
      const raw = this.storage.getItem(key);
      if (raw === null) continue;
      const value = identity(JSON.parse(raw));
      if (key !== REVOCATION_PREFIX + value.sessionId) throw new Error('Revocation identity mismatch');
      values.push(value);
    }
    return values;
  }

  acknowledge(session: SessionIdentity): void {
    this.storage.removeItem(REVOCATION_PREFIX + session.sessionId);
  }
}
