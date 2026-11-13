import { FastifyInstance } from 'fastify';
import { Pool, PoolClient } from 'pg';
import { BoardDoc, Camera, SCHEMA_VERSION } from '../../shared/model';
import { migrateBoard, NewerSchemaError } from '../../shared/migrations';
import { BoardValidationError } from '../../shared/validate';
import { BASIC_ATTACHMENT_BYTES } from '../../shared/attachment-policy';
import { Authentication } from './auth';
import { Role, digest } from './credentials';
import { transaction } from './database';
import { ApiError } from './errors';
import { OwnedBoard, activeAccount, objectBody, ownedBoard, revision, uuid } from './guards';
import { canonicalJson, mutation } from './mutations';
import { ObjectStorage, storageMissing } from './object-storage';

interface SaveInput {
  mutationId: string;
  expectedRevision: string | null;
  schemaVersion: number;
  doc: BoardDoc;
  camera: Camera;
}

function saveInput(value: unknown, id: string): SaveInput {
  const body = objectBody(value);
  if (Object.keys(body).some((key) => !['mutationId', 'expectedRevision', 'schemaVersion', 'doc', 'camera'].includes(key))) {
    throw new ApiError(400, 'INVALID_BOARD', 'Unsupported board fields.');
  }
  const rawDoc = objectBody(body['doc']);
  if (rawDoc['id'] !== id || typeof rawDoc['name'] !== 'string' || !rawDoc['name'].trim() || rawDoc['name'].length > 200 ||
    !Number.isInteger(body['schemaVersion']) || typeof body['schemaVersion'] !== 'number' || body['schemaVersion'] < 1) {
    throw new ApiError(400, 'INVALID_BOARD', 'Board identity, name or schema version is invalid.');
  }
  try {
    const board = migrateBoard(body);
    return {
      mutationId: uuid(body['mutationId']),
      expectedRevision: body['expectedRevision'] === null ? null : revision(body['expectedRevision']),
      schemaVersion: board.schemaVersion, doc: board.doc, camera: board.camera,
    };
  } catch (error) {
    if (error instanceof NewerSchemaError) throw new ApiError(422, 'NEWER_SCHEMA', 'This board requires a newer application version.');
    if (error instanceof BoardValidationError) throw new ApiError(400, 'INVALID_BOARD', 'The board document is invalid.');
    throw error;
  }
}

export async function validateAttachmentReferences(
  client: PoolClient, doc: BoardDoc, role: Role, storage?: ObjectStorage,
): Promise<void> {
  const references = Object.values(doc.nodes).flatMap((node) => {
    const files = node.attachments ?? [];
    if (role === 'basic' && files.length > 1) {
      throw new ApiError(422, 'ATTACHMENT_COUNT', 'Basic users can attach one file per block.');
    }
    return files.map((meta) => ({ nodeId: node.id, meta }));
  });
  const ids = [...new Set(references.map(({ meta }) => uuid(meta.id)))];
  if (!ids.length) return;
  const result = await client.query<{ id: string; name: string; mime: string; size_bytes: string; storage_key: string }>(`
    SELECT id, name, mime, size_bytes, storage_key FROM board_attachments
    WHERE board_id=$1 AND state='ready' AND id=ANY($2::uuid[]) FOR SHARE`, [doc.id, ids]);
  const stored = new Map(result.rows.map((row) => [row.id, row]));
  for (const { meta } of references) {
    const file = stored.get(meta.id);
    if (!file || !Number.isSafeInteger(meta.size) || meta.size < 0 || BigInt(meta.size).toString() !== file.size_bytes ||
      meta.name !== file.name || meta.mime !== file.mime) {
      throw new ApiError(422, 'ATTACHMENT_UNAVAILABLE', 'An attachment is missing, incomplete or has invalid metadata.');
    }
    if (!storage) throw new ApiError(503, 'ATTACHMENT_UNAVAILABLE', 'Attachment storage is unavailable.');
    for (const file of stored.values()) {
      try {
        if (String(await storage.head(file.storage_key)) !== file.size_bytes) {
          throw new ApiError(422, 'ATTACHMENT_UNAVAILABLE', 'Stored attachment bytes do not match their metadata.');
        }
      } catch (error) {
        if (storageMissing(error)) throw new ApiError(422, 'ATTACHMENT_UNAVAILABLE', 'Stored attachment bytes are missing.');
        throw error;
      }
    }
    if (role === 'basic' && meta.size > BASIC_ATTACHMENT_BYTES) {
      throw new ApiError(422, 'ATTACHMENT_SIZE', 'Basic users can attach files up to 5 MiB.');
    }
  }
}

export async function commitContentReferences(client: PoolClient, doc: BoardDoc, contentRevision: string, changed: boolean): Promise<void> {
  await client.query('DELETE FROM board_attachment_refs WHERE board_id=$1', [doc.id]);
  for (const node of Object.values(doc.nodes)) {
    for (const attachment of node.attachments ?? []) {
      await client.query(`INSERT INTO board_attachment_refs(board_id,node_id,attachment_id)
        VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [doc.id, node.id, attachment.id]);
      if (changed) await client.query(`INSERT INTO board_history_attachments(board_id,content_revision,node_id,attachment_id)
        VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [doc.id, contentRevision, node.id, attachment.id]);
    }
    await client.query(`UPDATE attachment_uploads SET basic_slot=false
      WHERE board_id=$1 AND state='completed' AND attachment_id IN
        (SELECT attachment_id FROM board_attachment_refs WHERE board_id=$1)`, [doc.id]);
  }
}

export const BASIC_HISTORY_LIMIT = 10;

/** Applies the owner's role retention in the committing transaction; the newest (current) revision is never removed. */
export async function pruneHistory(client: PoolClient, boardId: string, role: Role): Promise<void> {
  if (role !== 'basic') return;
  await client.query(`DELETE FROM board_history WHERE board_id=$1 AND content_revision <=
    (SELECT content_revision FROM board_history WHERE board_id=$1 ORDER BY content_revision DESC OFFSET $2 LIMIT 1)`,
  [boardId, BASIC_HISTORY_LIMIT]);
}

export function saveResult(board: OwnedBoard): Record<string, unknown> {
  return {
    id: board.id, revision: board.revision, contentRevision: board.content_revision,
    updatedAt: board.updated_at.toISOString(),
  };
}

export function registerBoards(app: FastifyInstance, pool: Pool, auth: Authentication, storage?: ObjectStorage): void {
  app.post<{ Params: { id: string } }>('/api/boards/:id/staging', async (request) => {
    const { account } = await auth.requireSession(request, true);
    const id = uuid(request.params.id);
    return transaction(pool, async (client) => {
      await activeAccount(client, account.id);
      await client.query(`INSERT INTO boards(id,owner_id,name,content,schema_version,content_hash,is_staged)
        VALUES ($1,$2,'Pending import','{}',$3,$4,true) ON CONFLICT (id) DO NOTHING`,
      [id, account.id, SCHEMA_VERSION, digest('{}')]);
      const { rows } = await client.query<OwnedBoard>(
        'SELECT * FROM boards WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, account.id]);
      if (!rows[0]?.is_staged || rows[0].deleted_at) {
        throw new ApiError(409, 'REVISION_CONFLICT', 'This board identity is already in use; choose a fresh identity.');
      }
      return { id, state: 'staged' };
    });
  });
  app.get<{ Querystring: { includeDeleted?: string } }>('/api/boards', async (request) => {
    const { account } = await auth.requireSession(request);
    const { rows } = await pool.query<{
      id: string; name: string; revision: string; updated_at: Date; deleted_at: Date | null;
    }>(`SELECT id,name,revision,updated_at,deleted_at FROM boards WHERE owner_id=$1 AND NOT is_staged
      ${request.query.includeDeleted === 'true' ? '' : 'AND deleted_at IS NULL'} ORDER BY updated_at DESC`, [account.id]);
    return rows.map((row) => ({
      id: row.id, name: row.name, revision: row.revision, updatedAt: row.updated_at.toISOString(),
      deletedAt: row.deleted_at?.toISOString() ?? null,
    }));
  });
  app.get<{ Params: { id: string } }>('/api/boards/:id', async (request) => {
    const { account } = await auth.requireSession(request);
    return transaction(pool, async (client) => {
      await activeAccount(client, account.id);
      const board = await ownedBoard(client, account.id, request.params.id);
      return {
        ...saveResult(board), name: board.name, schemaVersion: board.schema_version,
        doc: board.content, camera: board.camera,
      };
    });
  });
  app.put<{ Params: { id: string } }>('/api/boards/:id', async (request) => {
    const { account } = await auth.requireSession(request, true);
    const id = uuid(request.params.id);
    const input = saveInput(request.body, id);
    return mutation(pool, account.id, input.mutationId, { action: 'save-board', id, ...input }, async (client, currentAccount) => {
      const contentHash = digest(canonicalJson(input.doc));
      if (input.expectedRevision === null) {
        const staging = await client.query<OwnedBoard>(
          'SELECT * FROM boards WHERE id=$1 AND owner_id=$2 AND is_staged AND deleted_at IS NULL FOR UPDATE', [id, account.id]);
        await validateAttachmentReferences(client, input.doc, currentAccount.role, storage);
        const inserted = staging.rowCount
          ? await client.query<OwnedBoard>(`UPDATE boards SET name=$3,content=$4::jsonb,schema_version=$5,
              camera=$6::jsonb,content_hash=$7,is_staged=false,updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *`,
            [id, account.id, input.doc.name, JSON.stringify(input.doc), input.schemaVersion, JSON.stringify(input.camera), contentHash])
          : await client.query<OwnedBoard>(`INSERT INTO boards(id,owner_id,name,content,schema_version,camera,content_hash)
              VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7) ON CONFLICT (id) DO NOTHING RETURNING *`,
            [id, account.id, input.doc.name, JSON.stringify(input.doc), input.schemaVersion, JSON.stringify(input.camera), contentHash]);
        const board = inserted.rows[0];
        if (!board) throw new ApiError(409, 'REVISION_CONFLICT', 'The board identity already exists; reload before saving.');
        await client.query(`INSERT INTO board_history(board_id,content_revision,server_revision,name,content,schema_version,actor_id)
          VALUES ($1,1,1,$2,$3::jsonb,$4,$5)`, [id, board.name, JSON.stringify(input.doc), input.schemaVersion, account.id]);
        await commitContentReferences(client, input.doc, '1', true);
        return saveResult(board);
      }
      const existing = await ownedBoard(client, account.id, id, true, true);
      if (existing.deleted_at) throw new ApiError(410, 'BOARD_DELETED', 'This board was deleted; preserve pending work as a new board.');
      if (existing.schema_version > SCHEMA_VERSION) throw new ApiError(422, 'NEWER_SCHEMA', 'This board requires a newer application version.');
      if (existing.revision !== input.expectedRevision) {
        throw new ApiError(409, 'REVISION_CONFLICT', 'The board changed elsewhere; preserve pending work before reloading.');
      }
      await validateAttachmentReferences(client, input.doc, currentAccount.role, storage);
      const changed = existing.content_hash !== contentHash;
      if (!changed && canonicalJson(existing.camera) === canonicalJson(input.camera)) return saveResult(existing);
      const updated = await client.query<OwnedBoard>(`
        UPDATE boards SET name=$2,content=$3::jsonb,camera=$4::jsonb,schema_version=$5,
          revision=revision+1,content_revision=content_revision+$6,content_hash=$7,updated_at=now()
        WHERE id=$1 RETURNING *`,
      [id, input.doc.name, JSON.stringify(input.doc), JSON.stringify(input.camera), input.schemaVersion, changed ? 1 : 0, contentHash]);
      const board = updated.rows[0];
      if (!board) throw new Error('Board update returned no record');
      if (changed) {
        await client.query(`INSERT INTO board_history(board_id,content_revision,server_revision,name,content,schema_version,actor_id)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
        [id, board.content_revision, board.revision, board.name, JSON.stringify(input.doc), input.schemaVersion, account.id]);
        await commitContentReferences(client, input.doc, board.content_revision, true);
        await pruneHistory(client, id, currentAccount.role);
      }
      return saveResult(board);
    });
  });
  app.delete<{ Params: { id: string } }>('/api/boards/:id', async (request) => {
    const { account } = await auth.requireSession(request, true);
    const id = uuid(request.params.id);
    const body = objectBody(request.body);
    const expectedRevision = revision(body['expectedRevision']);
    const mutationId = uuid(body['mutationId']);
    if (Object.keys(body).some((key) => !['expectedRevision', 'mutationId'].includes(key))) {
      throw new ApiError(400, 'INVALID_REQUEST', 'Unsupported deletion fields.');
    }
    return mutation(pool, account.id, mutationId, { action: 'delete-board', id, expectedRevision }, async (client) => {
      const board = await ownedBoard(client, account.id, id, true, true);
      if (board.deleted_at) throw new ApiError(410, 'BOARD_DELETED', 'This board was deleted.');
      if (board.revision !== expectedRevision) throw new ApiError(409, 'REVISION_CONFLICT', 'The board changed before deletion; reload and confirm again.');
      await client.query('DELETE FROM board_attachment_refs WHERE board_id=$1', [id]);
      await client.query('DELETE FROM board_history WHERE board_id=$1', [id]);
      const result = await client.query<{ revision: string; deleted_at: Date }>(`
        UPDATE boards SET name='Deleted board',content=NULL,content_hash=NULL,camera='{}',
          revision=revision+1,deleted_at=now(),updated_at=now() WHERE id=$1 RETURNING revision,deleted_at`, [id]);
      const deleted = result.rows[0];
      if (!deleted) throw new Error('Board deletion returned no record');
      return { id, revision: deleted.revision, deletedAt: deleted.deleted_at.toISOString() };
    });
  });
}
