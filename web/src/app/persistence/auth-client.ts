import { Injectable } from '@angular/core';

export interface AuthSession {
  account: { id: string; username: string; display_name: string; role: 'basic' | 'admin' };
  sessionId: string;
  csrfToken: string;
  expiresAt: string;
}

export class CloudRequestError extends Error {
  constructor(readonly status: number, readonly code?: string) { super(`Cloud request failed (${status})`); }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function cachedAccount(value: unknown): AuthSession['account'] {
  if (!object(value)) throw new Error('Invalid cached account');
  if (typeof value['id'] !== 'string' || !uuid.test(value['id']) ||
      typeof value['username'] !== 'string' || typeof value['display_name'] !== 'string' ||
      (value['role'] !== 'basic' && value['role'] !== 'admin')) throw new Error('Invalid cached account');
  return { id: value['id'], username: value['username'], display_name: value['display_name'], role: value['role'] };
}

function session(value: unknown): AuthSession {
  if (!object(value)) throw new Error('Invalid session response');
  const account = cachedAccount(value['account']);
  if (typeof value['sessionId'] !== 'string' || !uuid.test(value['sessionId']) ||
      typeof value['csrfToken'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['csrfToken']) ||
      typeof value['expiresAt'] !== 'string' || !Number.isFinite(Date.parse(value['expiresAt']))) {
    throw new Error('Invalid session response');
  }
  return {
    account,
    sessionId: value['sessionId'], csrfToken: value['csrfToken'], expiresAt: value['expiresAt'],
  };
}

@Injectable({ providedIn: 'root' })
export class AuthClient {
  private async request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch('/api/auth/' + path, {
      ...init, signal: init?.signal ?? AbortSignal.timeout(30_000), credentials: 'same-origin', cache: 'no-store',
    });
    if (!response.ok) throw new CloudRequestError(response.status);
    return response;
  }

  async current(signal?: AbortSignal): Promise<AuthSession | null> {
    try { return session(await (await this.request('session', { signal })).json()); }
    catch (error) {
      if (error instanceof CloudRequestError && error.status === 401) return null;
      throw error;
    }
  }

  async login(username: string, password: string): Promise<AuthSession> {
    return session(await (await this.request('login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    })).json());
  }

  async logout(current: AuthSession, targetSessionId = current.sessionId): Promise<void> {
    await this.request('logout', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': current.csrfToken },
      body: JSON.stringify({ sessionId: targetSessionId, clearCookie: false }),
      signal: AbortSignal.timeout(15_000),
    });
  }
}
