import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import { verify } from 'argon2';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { ConfigurationError } from './config';
import { Account, Credentials, digest } from './credentials';
import { transaction } from './database';
import { ApiError } from './errors';
import { uuid } from './guards';

export interface AuthConfig {
  origin: string;
  secure: boolean;
}

export const SESSION_IDLE_SECONDS = 24 * 60 * 60;
export const SESSION_ABSOLUTE_SECONDS = 30 * 24 * 60 * 60;

export function readAuthConfig(environment: NodeJS.ProcessEnv = process.env): AuthConfig {
  const production = environment['NODE_ENV'] === 'production';
  const originInput = environment['APP_ORIGIN'] ?? (production ? '' : 'http://127.0.0.1:6610');
  let url: URL;
  try {
    url = new URL(originInput);
  } catch {
    throw new ConfigurationError('APP_ORIGIN', 'must be the application origin');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || originInput !== url.origin) {
    throw new ConfigurationError('APP_ORIGIN', 'must be an exact HTTP(S) origin without path or credentials');
  }
  if (url.protocol !== 'https:' && (production || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new ConfigurationError('APP_ORIGIN', 'requires HTTPS except for local development');
  }
  return { origin: url.origin, secure: url.protocol === 'https:' };
}

interface SessionRow extends Account {
  session_id: string;
  csrf_hash: string;
  expires_at: Date;
}

export interface Authenticated {
  account: Account;
  sessionId: string;
  csrfToken: string;
  expiresAt: string;
}

function csrfToken(token: string): string {
  return createHmac('sha256', token).update('friendly-mindmap-csrf').digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

export class Authentication {
  readonly cookieName: string;
  private readonly credentials: Credentials;

  constructor(private readonly pool: Pool, readonly config: AuthConfig) {
    this.cookieName = config.secure ? '__Host-mindmap' : 'mindmap-session';
    this.credentials = new Credentials(pool);
  }

  assertOrigin(request: FastifyRequest): void {
    if (request.headers.origin !== this.config.origin || request.headers['sec-fetch-site'] === 'cross-site') {
      throw new ApiError(403, 'INVALID_ORIGIN', 'The request origin is not allowed.');
    }
  }

  async requireSession(request: FastifyRequest, mutation = false): Promise<Authenticated> {
    if (mutation) this.assertOrigin(request);
    const token = request.cookies[this.cookieName];
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Please log in to continue.');
    }
    const { rows } = await this.pool.query<SessionRow>(`
      SELECT u.id, u.username, u.display_name, u.role, u.configuration, u.configuration_revision,
        s.id AS session_id, s.csrf_hash, s.expires_at
      FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
        AND s.idle_expires_at>now() AND u.disabled_at IS NULL`, [digest(token)]);
    const session = rows[0];
    if (!session) throw new ApiError(401, 'AUTH_REQUIRED', 'Please log in to continue.');
    const expectedSession = request.headers['x-session-id'];
    if (expectedSession !== undefined && expectedSession !== session.session_id) {
      throw new ApiError(401, 'SESSION_CHANGED', 'The browser session changed; verify the active account before continuing.');
    }
    const csrf = csrfToken(token);
    const supplied = request.headers['x-csrf-token'];
    if (mutation && (typeof supplied !== 'string' || supplied.length !== 64 ||
      !sameHash(digest(supplied), session.csrf_hash))) {
      throw new ApiError(403, 'INVALID_CSRF', 'The request verification token is invalid.');
    }
    await this.pool.query(`
      UPDATE sessions SET last_seen_at=now(),
        idle_expires_at=LEAST(expires_at, now()+make_interval(secs => $2))
      WHERE id=$1 AND revoked_at IS NULL`, [session.session_id, SESSION_IDLE_SECONDS]);
    const { session_id, csrf_hash: _csrf, expires_at, ...account } = session;
    return { account, sessionId: session_id, csrfToken: csrf, expiresAt: expires_at.toISOString() };
  }

  private setCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(this.cookieName, token, {
      path: '/', httpOnly: true, secure: this.config.secure, sameSite: 'strict', maxAge: SESSION_ABSOLUTE_SECONDS,
    });
  }

  async login(request: FastifyRequest, reply: FastifyReply): Promise<Authenticated> {
    this.assertOrigin(request);
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const account = await this.credentials.authenticate(
      'username' in body ? body.username : undefined,
      'password' in body ? body.password : undefined,
      request.ip,
    );
    const token = randomBytes(32).toString('hex');
    const csrf = csrfToken(token);
    const id = randomUUID();
    const previous = request.cookies[this.cookieName];
    const expiresAt = await transaction(this.pool, async (client) => {
      // Serialize issuance with password rotation, and recheck account disabling.
      const active = await client.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id=$1 AND disabled_at IS NULL FOR UPDATE', [account.id],
      );
      const password = 'password' in body ? body.password : undefined;
      if (!active.rows[0] || typeof password !== 'string' || !await verify(active.rows[0].password_hash, password)) {
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password.');
      }
      if (previous) await client.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [digest(previous)]);
      const result = await client.query<{ expires_at: Date }>(`
        INSERT INTO sessions(id,user_id,token_hash,csrf_hash,idle_expires_at,expires_at)
        VALUES ($1,$2,$3,$4,now()+make_interval(secs => $5),now()+make_interval(secs => $6))
        RETURNING expires_at`, [id, account.id, digest(token), digest(csrf), SESSION_IDLE_SECONDS, SESSION_ABSOLUTE_SECONDS]);
      const row = result.rows[0];
      if (!row) throw new Error('Session insertion returned no expiration');
      return row.expires_at.toISOString();
    });
    this.setCookie(reply, token);
    return { account, sessionId: id, csrfToken: csrf, expiresAt };
  }

  async logout(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const current = await this.requireSession(request, true);
    const body = request.body;
    const target = uuid(body && typeof body === 'object' && 'sessionId' in body ? body.sessionId : current.sessionId);
    if (body && typeof body === 'object' && 'clearCookie' in body && typeof body.clearCookie !== 'boolean') {
      throw new ApiError(400, 'INVALID_INPUT', 'clearCookie must be a boolean.');
    }
    await this.pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2', [target, current.account.id]);
    if (target === current.sessionId && !(body && typeof body === 'object' && 'clearCookie' in body && body.clearCookie === false)) {
      reply.clearCookie(this.cookieName, { path: '/', httpOnly: true, secure: this.config.secure, sameSite: 'strict' });
    }
  }
}

export function registerAuth(app: FastifyInstance, pool: Pool, config: AuthConfig): Authentication {
  app.register(cookie);
  const authentication = new Authentication(pool, config);
  app.post('/api/auth/login', async (request, reply) => authentication.login(request, reply));
  app.get('/api/auth/session', async (request) => authentication.requireSession(request));
  app.post('/api/auth/logout', async (request, reply) => {
    await authentication.logout(request, reply);
    return reply.code(204).send();
  });
  return authentication;
}
