import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { SCHEMA_VERSION } from '../../shared/model';
import { migrateBoard, NewerSchemaError } from '../../shared/migrations';
import { BoardValidationError } from '../../shared/validate';
import { Authentication } from './auth';
import { digest } from './credentials';
import { transaction } from './database';
import { ApiError } from './errors';
import { activeAccount, objectBody, ownedBoard, revision, uuid } from './guards';
import { canonicalJson, mutation } from './mutations';
import { ObjectStorage } from './object-storage';
import { commitContentReferences, pruneHistory, saveResult, validateAttachmentReferences } from './boards';

const DEFAULT_PAGE = 20;
const MAX_PAGE = 50;

interface HistoryRow {
  content_revision: string;
  server_revision: string;
  name: string;
  schema_version: number;
  actor_id: string;
  created_at: Date;
}

function summary(row: HistoryRow, currentRevision: string) {
  return {
    contentRevision: row.content_revision, serverRevision: row.server_revision, name: row.name,
    schemaVersion: row.schema_version, actorId: row.actor_id, createdAt: row.created_at.toISOString(),
    current: row.content_revision === currentRevision,
  };
}

function pageSize(value: unknown): number {
  if (value === undefined) return DEFAULT_PAGE;
  if (typeof value !== 'string' || !/^[1-9]\d{0,3}$/.test(value)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'A valid history page size is required.');
  }
  return Math.min(Number(value), MAX_PAGE);
}

export function registerHistory(app: FastifyInstance, pool: Pool, auth: Authentication, storage?: ObjectStorage): void {
  app.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>('/api/boards/:id/history', async (request) => {
    const { account } = await auth.requireSession(request);
    const limit = pageSize(request.query.limit);
    const before = request.query.before === undefined ? null : revision(request.query.before);
    return transaction(pool, async (client) => {
      await activeAccount(client, account.id);
      const board = await ownedBoard(client, account.id, request.params.id);
      const { rows } = await client.query<HistoryRow>(`
        SELECT content_revision,server_revision,name,schema_version,actor_id,created_at FROM board_history
        WHERE board_id=$1 AND ($2::bigint IS NULL OR content_revision < $2::bigint)
        ORDER BY content_revision DESC LIMIT $3`, [board.id, before, limit + 1]);
      const page = rows.slice(0, limit);
      return {
        items: page.map((row) => summary(row, board.content_revision)),
        nextBefore: rows.length > limit ? page[page.length - 1]?.content_revision ?? null : null,
      };
    });
  });

  app.get<{ Params: { id: string; contentRevision: string } }>('/api/boards/:id/history/:contentRevision', async (request) => {
    const { account } = await auth.requireSession(request);
    const contentRevision = revision(request.params.contentRevision);
    return transaction(pool, async (client) => {
      await activeAccount(client, account.id);
      const board = await ownedBoard(client, account.id, request.params.id);
      const { rows } = await client.query<HistoryRow & { content: unknown }>(`
        SELECT content_revision,server_revision,name,schema_version,actor_id,created_at,content FROM board_history
        WHERE board_id=$1 AND content_revision=$2`, [board.id, contentRevision]);
      const row = rows[0];
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.');
      const files = await client.query<{
        node_id: string; id: string; name: string; mime: string; size_bytes: string; checksum: string | null; state: string;
      }>(`SELECT h.node_id,a.id,a.name,a.mime,a.size_bytes,a.checksum,a.state
        FROM board_history_attachments h JOIN board_attachments a ON a.id=h.attachment_id AND a.board_id=h.board_id
        WHERE h.board_id=$1 AND h.content_revision=$2 ORDER BY h.node_id, a.id`, [board.id, contentRevision]);
      return {
        ...summary(row, board.content_revision), doc: row.content,
        attachments: files.rows.map((file) => ({
          nodeId: file.node_id, id: file.id, name: file.name, mime: file.mime, size: Number(file.size_bytes),
          checksum: file.checksum, available: file.state === 'ready',
        })),
      };
    });
  });

  app.post<{ Params: { id: string; contentRevision: string } }>('/api/boards/:id/history/:contentRevision/restore', async (request) => {
    const { account } = await auth.requireSession(request, true);
    const id = uuid(request.params.id);
    const contentRevision = revision(request.params.contentRevision);
    const body = objectBody(request.body);
    if (Object.keys(body).some((key) => !['mutationId', 'expectedRevision'].includes(key))) {
      throw new ApiError(400, 'INVALID_REQUEST', 'Unsupported restore fields.');
    }
    const mutationId = uuid(body['mutationId']);
    const expectedRevision = revision(body['expectedRevision']);
    return mutation(pool, account.id, mutationId, { action: 'restore-board-history', id, contentRevision, expectedRevision },
      async (client, currentAccount) => {
        const existing = await ownedBoard(client, account.id, id, true, true);
        if (existing.deleted_at) throw new ApiError(410, 'BOARD_DELETED', 'This board was deleted; preserve pending work as a new board.');
        if (existing.schema_version > SCHEMA_VERSION) throw new ApiError(422, 'NEWER_SCHEMA', 'This board requires a newer application version.');
        if (existing.revision !== expectedRevision) {
          throw new ApiError(409, 'REVISION_CONFLICT', 'The board changed elsewhere; reload before restoring.');
        }
        const { rows } = await client.query<{ content: unknown; schema_version: number }>(
          'SELECT content,schema_version FROM board_history WHERE board_id=$1 AND content_revision=$2', [id, contentRevision]);
        const snapshot = rows[0];
        if (!snapshot) throw new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.');
        let restored;
        try {
          restored = migrateBoard({ schemaVersion: snapshot.schema_version, doc: snapshot.content, camera: existing.camera });
        } catch (error) {
          if (error instanceof NewerSchemaError) throw new ApiError(422, 'NEWER_SCHEMA', 'This revision requires a newer application version.');
          if (error instanceof BoardValidationError) throw new ApiError(422, 'INVALID_BOARD', 'This revision cannot be restored.');
          throw error;
        }
        const contentHash = digest(canonicalJson(restored.doc));
        await validateAttachmentReferences(client, restored.doc, currentAccount.role, storage);
        if (existing.content_hash === contentHash) return saveResult(existing);
        const updated = await client.query<typeof existing>(`
          UPDATE boards SET name=$2,content=$3::jsonb,schema_version=$4,revision=revision+1,
            content_revision=content_revision+1,content_hash=$5,updated_at=now()
          WHERE id=$1 RETURNING *`,
        [id, restored.doc.name, JSON.stringify(restored.doc), restored.schemaVersion, contentHash]);
        const board = updated.rows[0];
        if (!board) throw new Error('Board restore returned no record');
        await client.query(`INSERT INTO board_history(board_id,content_revision,server_revision,name,content,schema_version,actor_id)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
        [id, board.content_revision, board.revision, board.name, JSON.stringify(restored.doc), restored.schemaVersion, account.id]);
        await commitContentReferences(client, restored.doc, board.content_revision, true);
        await pruneHistory(client, id, currentAccount.role);
        return { ...saveResult(board), restoredContentRevision: contentRevision };
      });
  });
}
