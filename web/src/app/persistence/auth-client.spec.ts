import { AuthClient, CloudRequestError } from './auth-client';

describe('same-origin authentication client', () => {
  const original = globalThis.fetch;
  const fetchMock = jest.fn();
  beforeEach(() => { globalThis.fetch = fetchMock; fetchMock.mockReset(); });
  afterAll(() => { globalThis.fetch = original; });

  it('treats only 401 as guest and surfaces network/server/invalid response errors', async () => {
    const client = new AuthClient();
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    expect(await client.current()).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }));
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await expect(client.current()).rejects.toBeInstanceOf(CloudRequestError);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ account: { role: 'admin' } }) });
    await expect(client.current()).rejects.toThrow('Invalid cached account');
  });

  it('uses the captured session identity/CSRF token for logout without storing credentials', async () => {
    const client = new AuthClient();
    fetchMock.mockResolvedValue({ ok: true });
    const current = {
      account: { id: crypto.randomUUID(), username: 'test', display_name: 'Test', role: 'basic' as const },
      sessionId: crypto.randomUUID(), csrfToken: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00Z',
    };
    await client.logout(current);
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': current.csrfToken },
      body: JSON.stringify({ sessionId: current.sessionId, clearCookie: false }),
    }));
    const previousId = crypto.randomUUID();
    await client.logout(current, previousId);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/auth/logout', expect.objectContaining({
      body: JSON.stringify({ sessionId: previousId, clearCookie: false }),
    }));
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    await expect(client.logout(current, previousId)).rejects.toBeInstanceOf(CloudRequestError);
  });
});
