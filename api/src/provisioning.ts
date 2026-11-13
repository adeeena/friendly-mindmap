import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { Account, hashPassword, normalizeUsername } from './credentials';
import { ConfigurationError } from './config';
import { transaction } from './database';
import { ApiError } from './errors';

function accountName(username: string): string {
  const normalized = normalizeUsername(username);
  if (!normalized || normalized.length > 100) {
    throw new ConfigurationError('ACCOUNT_USERNAME', 'must contain between 1 and 100 characters');
  }
  return normalized;
}

export async function readAccountPassword(environment: NodeJS.ProcessEnv): Promise<string> {
  const value = environment['ACCOUNT_PASSWORD'];
  const file = environment['ACCOUNT_PASSWORD_FILE'];
  if ((value && file) || (!value && !file)) {
    throw new ConfigurationError('ACCOUNT_PASSWORD', 'supply exactly one of ACCOUNT_PASSWORD or ACCOUNT_PASSWORD_FILE');
  }
  return value ?? (await readFile(file!, 'utf8')).replace(/\r?\n$/, '');
}

export async function bootstrapAdmin(
  pool: Pool, username: string, password: string, environment: NodeJS.ProcessEnv = process.env,
): Promise<{ created: boolean }> {
  if (environment['NODE_ENV'] !== 'development') {
    throw new ConfigurationError('NODE_ENV', 'development is required for explicit admin bootstrap');
  }
  const name = accountName(username);
  const encoded = await hashPassword(password);
  const result = await pool.query(`
    INSERT INTO users(id,username,display_name,password_hash,role)
    VALUES ($1,$2,$3,$4,'admin') ON CONFLICT (username) DO NOTHING`,
  [randomUUID(), name, username.trim(), encoded]);
  return { created: result.rowCount === 1 };
}

export async function changePassword(pool: Pool, username: string, password: string): Promise<void> {
  const name = accountName(username);
  const encoded = await hashPassword(password);
  await transaction(pool, async (client) => {
    const result = await client.query<Account>('SELECT id FROM users WHERE username=$1 FOR UPDATE', [name]);
    const account = result.rows[0];
    if (!account) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'No matching account exists.');
    await client.query('UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1', [account.id, encoded]);
    await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [account.id]);
  });
}
