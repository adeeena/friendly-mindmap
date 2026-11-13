import { createHash, randomBytes } from 'node:crypto';
import { argon2id, hash, verify } from 'argon2';
import { Pool } from 'pg';
import { ApiError } from './errors';

export type Role = 'basic' | 'admin';

export interface Account {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  configuration: Record<string, unknown>;
  configuration_revision: string;
}

interface CredentialAccount extends Account {
  password_hash: string;
  disabled_at: Date | null;
}

export function normalizeUsername(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashPassword(password: string): Promise<string> {
  if (password.length < 8 || password.length > 1024) {
    throw new ApiError(400, 'INVALID_PASSWORD', 'Password must be between 8 and 1024 characters.');
  }
  return hash(password, { type: argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
}

export class Credentials {
  private readonly dummyHash = hashPassword(randomBytes(32).toString('hex'));

  constructor(private readonly pool: Pool) {}

  private async throttle(username: string, address: string): Promise<void> {
    const keys = [
      { key: digest(`login-ip:${address}`), limit: 100 },
      { key: digest(`login-account:${username}`), limit: 10 },
    ];
    for (const { key, limit } of keys) {
      const { rows } = await this.pool.query<{ attempts: number }>(`
        INSERT INTO login_attempts(key_hash, attempts) VALUES ($1, 1)
        ON CONFLICT (key_hash) DO UPDATE SET
          attempts = CASE WHEN login_attempts.window_started_at <= now() - interval '15 minutes'
            THEN 1 ELSE login_attempts.attempts + 1 END,
          window_started_at = CASE WHEN login_attempts.window_started_at <= now() - interval '15 minutes'
            THEN now() ELSE login_attempts.window_started_at END
        RETURNING attempts`, [key]);
      if ((rows[0]?.attempts ?? limit + 1) > limit) {
        throw new ApiError(429, 'LOGIN_THROTTLED', 'Too many login attempts. Please try again later.');
      }
    }
  }

  async authenticate(usernameInput: unknown, passwordInput: unknown, address: string): Promise<Account> {
    const username = typeof usernameInput === 'string' ? normalizeUsername(usernameInput.slice(0, 1000)) : '';
    await this.throttle(username, address);
    if (!username || username.length > 100 || typeof passwordInput !== 'string' || passwordInput.length > 1024) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password.');
    }
    const { rows } = await this.pool.query<CredentialAccount>(
      'SELECT id, username, display_name, role, configuration, configuration_revision, password_hash, disabled_at FROM users WHERE username=$1',
      [username],
    );
    const account = rows[0];
    const correct = await verify(account?.password_hash ?? await this.dummyHash, passwordInput);
    if (!account || !correct || account.disabled_at) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password.');
    }
    const { password_hash: _password, disabled_at: _disabled, ...publicAccount } = account;
    return publicAccount;
  }
}
