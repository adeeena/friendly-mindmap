import 'fake-indexeddb/auto';
import { deserialize, serialize } from 'node:v8';
import { DestroyRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EditorStore } from '../editor/editor-store';
import { createBoard, SCHEMA_VERSION } from '../core/model';
import { AuthClient, AuthSession, CloudRequestError } from './auth-client';
import { BOARD_REPOSITORY, MemoryBoardRepository } from './board-repository';
import { BoardSession } from './board-session';
import { lockableRepository, WorkspaceLockedError } from './locked-repository';
import { CLOUD_BOARD_CLIENT, WorkspaceSession } from './workspace-session';
import { AccountSync } from './account-sync';
import { AccountPreferences } from './account-preferences';
import { WorkspaceAuthState } from './workspace-auth-state';

function authenticated(id = crypto.randomUUID()): AuthSession {
  return {
    account: { id, username: 'test', display_name: 'Test Admin', role: 'admin' },
    sessionId: crypto.randomUUID(), csrfToken: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z',
  };
}

describe('workspace transitions', () => {
  const originalClone = globalThis.structuredClone;
  beforeAll(() => { globalThis.structuredClone = (value) => deserialize(serialize(value)); });
  afterAll(() => { globalThis.structuredClone = originalClone; });
  let guest: MemoryBoardRepository;
  let boards: BoardSession;
  let store: EditorStore;
  let workspace: WorkspaceSession;
  let auth: { current: jest.Mock; login: jest.Mock; logout: jest.Mock };

  beforeEach(async () => {
    jest.spyOn(AccountSync.prototype, 'start').mockImplementation(() => {});
    jest.spyOn(AccountPreferences.prototype, 'start').mockImplementation(() => {});
    localStorage.clear();
    guest = new MemoryBoardRepository();
    auth = { current: jest.fn().mockResolvedValue(null), login: jest.fn(), logout: jest.fn().mockResolvedValue(undefined) };
    TestBed.configureTestingModule({ providers: [
      { provide: BOARD_REPOSITORY, useValue: guest }, { provide: AuthClient, useValue: auth },
      { provide: CLOUD_BOARD_CLIENT, useValue: { list: jest.fn().mockResolvedValue([]) } },
    ] });
    boards = TestBed.inject(BoardSession);
    store = TestBed.inject(EditorStore);
    workspace = TestBed.inject(WorkspaceSession);
    await workspace.init(TestBed.inject(DestroyRef));
    store.renameBoard('Private guest work');
    await boards.flush();
  });

  it('login never merges/uploads guest data and logout restores the guest board and locks the old cache', async () => {
    const guestId = store.doc().id;
    const account = authenticated();
    auth.login.mockResolvedValue(account);
    const switching = jest.spyOn(boards, 'switchRepository');
    const loggedIn = await workspace.login('test', 'test-only-password');
    if (!loggedIn) await switching.mock.results[0]?.value;
    expect(loggedIn).toBe(true);
    expect(workspace.account()?.display_name).toBe('Test Admin');
    const privateRepository = boards.repository;
    expect(privateRepository.workspace).toEqual({ kind: 'account', accountId: account.account.id });
    expect(store.doc().id).not.toBe(guestId);
    expect(await privateRepository.load(guestId)).toBeNull();
    store.renameBoard('Account work');
    await boards.flush();
    expect((await guest.load(guestId))?.name).toBe('Private guest work');
    expect(await workspace.logout()).toBe(true);
    auth.current.mockResolvedValue(account);
    await workspace.retryRevocations();
    expect(auth.logout).toHaveBeenCalledWith(account, account.sessionId);
    expect(store.doc().id).toBe(guestId);
    expect(store.doc().name).toBe('Private guest work');
    expect(workspace.account()).toBeNull();
    await expect(privateRepository.list()).rejects.toBeInstanceOf(WorkspaceLockedError);
  });

  it('failed login preserves the active workspace; offline logout locks locally and durably defers server revocation', async () => {
    const id = store.doc().id;
    auth.login.mockRejectedValue(new CloudRequestError(401));
    expect(await workspace.login('test', 'invalid-test-password')).toBe(false);
    expect(workspace.error()).toBe('auth.invalid');
    expect(store.doc().id).toBe(id);
    const account = authenticated();
    auth.login.mockResolvedValue(account);
    await workspace.login('test', 'test-only-password');
    const privateRepository = boards.repository;
    auth.current.mockRejectedValue(new TypeError('Network unavailable'));
    auth.logout.mockRejectedValue(new TypeError('Network unavailable'));
    expect(await workspace.logout()).toBe(true);
    await workspace.retryRevocations();
    expect(workspace.error()).toBe('auth.revokeOnReconnect');
    expect(store.doc().id).toBe(id);
    expect(store.readOnly()).toBe(false);
    expect(workspace.account()).toBeNull();
    await expect(privateRepository.list()).rejects.toBeInstanceOf(WorkspaceLockedError);
    expect(new WorkspaceAuthState(localStorage).pending()).toEqual([{ accountId: account.account.id, sessionId: account.sessionId }]);
  });

  it('revokes captured old identities with a fresh matching session, never another account or the newer session', async () => {
    const state = new WorkspaceAuthState(localStorage);
    const old = authenticated();
    state.defer({ accountId: old.account.id, sessionId: old.sessionId });
    const other = authenticated();
    await workspace.retryRevocations(other);
    expect(auth.logout).not.toHaveBeenCalled();
    expect(state.pending()).toHaveLength(1);
    const fresh = { ...old, sessionId: crypto.randomUUID(), csrfToken: 'b'.repeat(64) };
    await workspace.retryRevocations(fresh);
    expect(auth.logout).toHaveBeenCalledWith(fresh, old.sessionId);
    expect(state.pending()).toEqual([]);
    expect(workspace.error()).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain(fresh.csrfToken);
  });

  it('live account lock events return to guest without discarding pending private work', async () => {
    const current = authenticated();
    auth.login.mockResolvedValue(current);
    await workspace.login('test', 'test-only-password');
    const oldRepository = boards.repository;
    store.renameBoard('Pending before other tab logout');
    await boards.flush();
    new WorkspaceAuthState(localStorage).lock(current.account.id);
    window.dispatchEvent(new StorageEvent('storage', {
      storageArea: localStorage, key: 'better-mindmap-account-lock:' + current.account.id, newValue: 'locked',
    }));
    for (let attempt = 0; attempt < 100 && workspace.account(); attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(workspace.account()).toBeNull();
    expect(workspace.error()).toBe('auth.sessionLocked');
    expect(store.doc().name).toBe('Private guest work');
    await expect(oldRepository.list()).rejects.toBeInstanceOf(WorkspaceLockedError);
    auth.login.mockResolvedValue({ ...current, sessionId: crypto.randomUUID() });
    expect(await workspace.login('test', 'test-only-password')).toBe(true);
    expect(store.doc().name).toBe('Pending before other tab logout');
  });

  it('delayed account A loads cannot replace the account B document', async () => {
    auth.login.mockResolvedValue(authenticated());
    await workspace.login('test', 'test-only-password');
    const first = boards.repository;
    const id = store.doc().id;
    const original = first.load.bind(first);
    const record = await original(id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    jest.spyOn(first, 'load').mockImplementation(async () => { await gate; return record; });
    const delayed = boards.open(id);
    await workspace.logout();
    auth.login.mockResolvedValue(authenticated());
    await workspace.login('second', 'test-only-password');
    store.renameBoard('Account B');
    await boards.flush();
    release();
    expect(await delayed).toBe(false);
    expect(store.doc().name).toBe('Account B');
    expect(boards.repository.workspace).not.toEqual(first.workspace);
  });

  it('does not auto-open a locally locked account from a stale cookie', async () => {
    const account = authenticated();
    localStorage.setItem('better-mindmap-locked-accounts', JSON.stringify([account.account.id]));
    auth.current.mockResolvedValue(account);
    await workspace.init(TestBed.inject(DestroyRef));
    expect(workspace.account()).toBeNull();
    expect(boards.repository.workspace).toEqual({ kind: 'guest' });
    expect(store.doc().name).toBe('Private guest work');
  });

  it('cold offline startup opens only the last unlocked cache and never treats it as verified', async () => {
    const account = authenticated();
    auth.login.mockResolvedValue(account);
    await workspace.login('test', 'test-only-password');
    store.renameBoard('Durable offline account');
    await boards.flush();
    TestBed.resetTestingModule();
    auth.current.mockRejectedValue(new TypeError('Network unavailable'));
    TestBed.configureTestingModule({ providers: [
      { provide: BOARD_REPOSITORY, useValue: guest }, { provide: AuthClient, useValue: auth },
      { provide: CLOUD_BOARD_CLIENT, useValue: { list: jest.fn().mockResolvedValue([]) } },
    ] });
    workspace = TestBed.inject(WorkspaceSession);
    store = TestBed.inject(EditorStore);
    await workspace.init(TestBed.inject(DestroyRef));
    expect(workspace.account()?.id).toBe(account.account.id);
    expect(workspace.verified()).toBe(false);
    expect(store.doc().name).toBe('Durable offline account');
    expect(workspace.error()).toBe('auth.offline');
    expect(await workspace.logout()).toBe(true);
    expect(store.doc().name).toBe('Private guest work');
    expect(localStorage.getItem('better-mindmap-last-account')).toBeNull();
  });
});

it('locks delayed cache results as well as future calls', async () => {
  const raw = new MemoryBoardRepository();
  const doc = createBoard('Private');
  await raw.save({ id: doc.id, name: doc.name, doc, schemaVersion: SCHEMA_VERSION,
    updatedAt: Date.now(), camera: { x: 0, y: 0, zoom: 1 } }, null);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = raw.load.bind(raw);
  jest.spyOn(raw, 'load').mockImplementation(async (...args) => { await gate; return original(...args); });
  const locked = lockableRepository(raw);
  const delayed = locked.repository.load(doc.id);
  locked.lock();
  release();
  await expect(delayed).rejects.toBeInstanceOf(WorkspaceLockedError);
  await expect(locked.repository.list()).rejects.toBeInstanceOf(WorkspaceLockedError);
});
