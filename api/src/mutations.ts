import { Pool, PoolClient } from 'pg';
import { Account, digest } from './credentials';
import { transaction } from './database';
import { ApiError } from './errors';
import { activeAccount, uuid } from './guards';
import { canonicalJson as serializeCanonicalJson } from '../../shared/canonical-json';

export function canonicalJson(value: unknown): string {
  const json = serializeCanonicalJson(value);
  if (json === undefined) throw new ApiError(400, 'INVALID_REQUEST', 'A JSON value is required.');
  return json;
}

export async function mutation(
  pool: Pool, ownerId: string, mutationId: string, request: unknown,
  action: (client: PoolClient, account: Account) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  uuid(mutationId);
  const fingerprint = digest(canonicalJson(request));
  return transaction(pool, async (client) => {
    const account = await activeAccount(client, ownerId);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${ownerId}:${mutationId}`]);
    const receipt = await client.query<{ request_hash: string; result: Record<string, unknown> }>(
      'SELECT request_hash, result FROM mutation_receipts WHERE owner_id=$1 AND mutation_id=$2', [ownerId, mutationId],
    );
    const existing = receipt.rows[0];
    if (existing) {
      if (existing.request_hash !== fingerprint) {
        throw new ApiError(409, 'MUTATION_MISMATCH', 'This operation identifier was already used for a different request.');
      }
      return existing.result;
    }
    const result = await action(client, account);
    await client.query('INSERT INTO mutation_receipts(owner_id,mutation_id,request_hash,result) VALUES ($1,$2,$3,$4::jsonb)',
      [ownerId, mutationId, fingerprint, JSON.stringify(result)]);
    return result;
  });
}
