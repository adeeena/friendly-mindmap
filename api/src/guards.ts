import { PoolClient } from 'pg';
import { Account } from './credentials';
import { ApiError } from './errors';

export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'A JSON object is required.');
  }
  return value as Record<string, unknown>;
}

export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'A valid UUID is required.');
  }
  return value;
}

export function revision(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new ApiError(400, 'INVALID_REQUEST', 'A valid revision string is required.');
  }
  return value;
}

export async function activeAccount(client: PoolClient, userId: string, lock = false): Promise<Account> {
  const { rows } = await client.query<Account>(`
    SELECT id, username, display_name, role, configuration, configuration_revision
    FROM users WHERE id=$1 AND disabled_at IS NULL ${lock ? 'FOR UPDATE' : 'FOR SHARE'}`, [userId]);
  const account = rows[0];
  if (!account) throw new ApiError(401, 'AUTH_REQUIRED', 'Please log in to continue.');
  return account;
}

export interface OwnedBoard {
  id: string;
  owner_id: string;
  revision: string;
  content_revision: string;
  schema_version: number;
  name: string;
  content: unknown;
  camera: unknown;
  content_hash: string | null;
  updated_at: Date;
  deleted_at: Date | null;
  is_staged: boolean;
}

export async function ownedBoard(
  client: PoolClient, userId: string, boardId: string, lock = false, includeDeleted = false, includeStaged = false,
): Promise<OwnedBoard> {
  const { rows } = await client.query<OwnedBoard>(
    `SELECT * FROM boards WHERE id=$1 AND owner_id=$2 ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
      ${includeStaged ? '' : 'AND NOT is_staged'} ${lock ? 'FOR UPDATE' : ''}`,
    [uuid(boardId), userId],
  );
  const board = rows[0];
  if (!board) throw new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.');
  return board;
}
