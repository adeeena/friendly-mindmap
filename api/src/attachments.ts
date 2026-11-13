import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { Authentication } from './auth';
import { ApiError } from './errors';
import { uuid } from './guards';
import { ObjectStorage } from './object-storage';

export function registerAttachments(app: FastifyInstance, pool: Pool, auth: Authentication, storage: ObjectStorage): void {
  app.get<{ Params: { boardId: string; attachmentId: string } }>(
    '/api/boards/:boardId/attachments/:attachmentId', async (request, reply) => {
      const { account } = await auth.requireSession(request);
      const boardId = uuid(request.params.boardId);
      const attachmentId = uuid(request.params.attachmentId);
      const { rows } = await pool.query<{ storage_key: string; name: string; mime: string; size_bytes: string; checksum: string }>(`
        SELECT a.storage_key,a.name,a.mime,a.size_bytes,a.checksum
        FROM board_attachments a JOIN boards b ON b.id=a.board_id AND b.owner_id=a.owner_id
        WHERE a.id=$1 AND a.board_id=$2 AND b.owner_id=$3 AND b.deleted_at IS NULL AND NOT b.is_staged AND a.state='ready'
          AND (EXISTS (SELECT 1 FROM board_attachment_refs r WHERE r.attachment_id=a.id)
            OR EXISTS (SELECT 1 FROM board_history_attachments h WHERE h.attachment_id=a.id))`,
      [attachmentId, boardId, account.id]);
      const attachment = rows[0];
      if (!attachment) throw new ApiError(404, 'NOT_FOUND', 'The requested attachment was not found.');
      const object = await storage.download(attachment.storage_key);
      if (object.size?.toString() !== attachment.size_bytes) {
        object.body.destroy();
        throw new ApiError(503, 'ATTACHMENT_UNAVAILABLE', 'Attachment storage is inconsistent; please retry or contact the operator.');
      }
      const filename = attachment.name.replace(/[\x00-\x1f\x7f"\\]/g, '_');
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`);
      reply.header('Content-Length', attachment.size_bytes);
      reply.header('X-Content-SHA256', attachment.checksum);
      return reply.send(object.body);
    },
  );
}
