/**
 * @jest-environment node
 */
import { randomUUID } from 'node:crypto';
import { AccountPreferences, validPreferences } from './account-preferences';
import { AuthSession, CloudRequestError } from './auth-client';

function session(accountId: string): AuthSession {
  return { account: { id: accountId, role: 'basic', username: 'test', display_name: 'Test' },
    sessionId: randomUUID(), csrfToken: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00Z' };
}

class MemoryStore {
  readonly values = new Map<string, unknown>();
  async getMeta<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async setMeta(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

describe('account preferences', () => {
  const instances: AccountPreferences[] = [];
  function setup(remote = { values: {} as Record<string, string>, revision: '0' }) {
    const account = randomUUID();
    const store = new MemoryStore();
    const state = { ...remote, values: { ...remote.values } };
    const client = {
      load: jest.fn(async () => ({ values: { ...state.values }, revision: state.revision })),
      patch: jest.fn(async (_session: AuthSession, expected: string, changes: Record<string, string>) => {
        if (expected !== state.revision) throw new CloudRequestError(409, 'REVISION_CONFLICT');
        Object.assign(state.values, changes);
        state.revision = String(BigInt(state.revision) + 1n);
        return { values: { ...state.values }, revision: state.revision };
      }),
    };
    const applied = jest.fn();
    const current = jest.fn(async () => session(account));
    const prefs = new AccountPreferences(account, store, { current, applied, client: client as never, events: null, channel: null });
    instances.push(prefs);
    return { account, store, state, client, applied, current, prefs };
  }
  afterEach(async () => { await Promise.all(instances.splice(0).map((prefs) => prefs.stop())); });

  it('ignores unknown or invalid fields from the server or a damaged cache', () => {
    expect(validPreferences({ theme: 'neon', language: 'hu', extra: 1 })).toEqual({ language: 'hu' });
    expect(validPreferences(null)).toEqual({});
  });

  it('keeps an offline edit durable, then sends only that field with the current revision', async () => {
    const fixture = setup({ values: { language: 'hu' }, revision: '3' });
    fixture.current.mockResolvedValueOnce(null);
    await fixture.prefs.change({ theme: 'win98' });
    expect(await fixture.prefs.effective()).toEqual({ theme: 'win98' });
    expect(fixture.client.patch).not.toHaveBeenCalled();
    await fixture.prefs.synchronize();
    expect(fixture.client.load).not.toHaveBeenCalled();
    await fixture.prefs.synchronize();
    expect(fixture.client.patch).toHaveBeenCalledWith(expect.anything(), '3', { theme: 'win98' }, expect.anything());
    expect(fixture.state.values).toEqual({ language: 'hu', theme: 'win98' });
    expect(fixture.applied).toHaveBeenLastCalledWith({ language: 'hu', theme: 'win98' });
    expect(fixture.store.values.get('preferencesPending')).toEqual({});
    expect(await fixture.prefs.effective()).toEqual({ language: 'hu', theme: 'win98' });
  });

  it('merges concurrent changes to different fields from another device and retries a revision conflict', async () => {
    const fixture = setup({ values: { theme: 'dark' }, revision: '1' });
    await fixture.prefs.change({ theme: 'pale-rose' });
    let raced = false;
    const patch = fixture.client.patch.getMockImplementation()!;
    fixture.client.patch.mockImplementation(async (...args) => {
      if (!raced) {
        raced = true;
        fixture.state.values['language'] = 'fr';
        fixture.state.revision = '2';
      }
      return patch(...args);
    });
    await fixture.prefs.synchronize();
    expect(fixture.client.patch.mock.calls.map((call) => call[1])).toEqual(['1', '2']);
    expect(fixture.state.values).toEqual({ theme: 'pale-rose', language: 'fr' });
    expect(fixture.applied).toHaveBeenLastCalledWith({ theme: 'pale-rose', language: 'fr' });
  });

  it('does not discard a newer edit made while the request was in flight', async () => {
    const fixture = setup({ values: {}, revision: '0' });
    await fixture.prefs.change({ theme: 'win98' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const patch = fixture.client.patch.getMockImplementation()!;
    fixture.client.patch.mockImplementationOnce(async (...args) => { await gate; return patch(...args); });
    const running = fixture.prefs.synchronize();
    for (let tick = 0; tick < 20 && !fixture.client.patch.mock.calls.length; tick++) await new Promise((r) => setTimeout(r, 5));
    await fixture.prefs.change({ theme: 'cs3-gray' });
    release();
    await running;
    expect(fixture.store.values.get('preferencesPending')).toEqual({ theme: 'cs3-gray' });
    expect(fixture.applied).toHaveBeenLastCalledWith({ theme: 'cs3-gray' });
    await fixture.prefs.synchronize();
    expect(fixture.state.values).toEqual({ theme: 'cs3-gray' });
    expect(fixture.store.values.get('preferencesPending')).toEqual({});
  });

  it('never sends preferences under another account’s session', async () => {
    const fixture = setup();
    fixture.current.mockResolvedValue(session(randomUUID()));
    await fixture.prefs.change({ theme: 'dark' });
    await fixture.prefs.synchronize();
    expect(fixture.client.load).not.toHaveBeenCalled();
    expect(fixture.client.patch).not.toHaveBeenCalled();
    expect(await fixture.prefs.effective()).toEqual({ theme: 'dark' });
  });

  it('adopts remote values on another device when nothing is pending', async () => {
    const fixture = setup({ values: { theme: 'cs3-gray', language: 'hu' }, revision: '5' });
    await fixture.prefs.synchronize();
    expect(fixture.client.patch).not.toHaveBeenCalled();
    expect(fixture.applied).toHaveBeenLastCalledWith({ theme: 'cs3-gray', language: 'hu' });
    expect(await fixture.prefs.effective()).toEqual({ theme: 'cs3-gray', language: 'hu' });
  });
});
