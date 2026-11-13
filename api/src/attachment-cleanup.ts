import { FastifyBaseLogger } from 'fastify';
import { Pool } from 'pg';
import { transaction } from './database';
import { safeDiagnostic } from './errors';
import { ObjectStorage } from './object-storage';

const GRACE_HOURS = 24;
const BATCH_SIZE = 25;

const unreferenced = `
  NOT EXISTS (SELECT 1 FROM board_attachment_refs r WHERE r.attachment_id=a.id)
  AND NOT EXISTS (SELECT 1 FROM board_history_attachments h WHERE h.attachment_id=a.id)`;
const eligible = `(a.state='deleting' OR b.deleted_at IS NOT NULL OR
  (NOT EXISTS (SELECT 1 FROM attachment_uploads u WHERE u.attachment_id=a.id
      AND u.state IN ('pending','uploading') AND u.expires_at>now())
    AND (a.updated_at<now()-make_interval(hours=>$1) OR EXISTS
      (SELECT 1 FROM attachment_uploads u WHERE u.attachment_id=a.id
        AND (u.state IN ('expired','aborted') OR (u.state IN ('pending','uploading') AND u.expires_at<=now()))))))`;

export async function cleanupAttachments(pool: Pool, storage: ObjectStorage) {
  const expiredBoards = await transaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(`SELECT b.id FROM boards b
      WHERE is_staged AND deleted_at IS NULL AND updated_at<now()-make_interval(hours=>$1)
        AND NOT EXISTS (SELECT 1 FROM attachment_uploads u WHERE u.board_id=b.id
          AND u.state IN ('pending','uploading') AND u.expires_at>now())
      ORDER BY updated_at LIMIT $2 FOR UPDATE SKIP LOCKED`, [GRACE_HOURS, BATCH_SIZE]);
    for (const board of rows) {
      await client.query(`UPDATE boards SET name='Deleted board',content=NULL,content_hash=NULL,camera='{}',
        revision=revision+1,deleted_at=now(),updated_at=now() WHERE id=$1`, [board.id]);
    }
    return rows.length;
  });
  const { rows: candidates } = await pool.query<{ id: string; board_id: string }>(`
    SELECT a.id,a.board_id FROM board_attachments a JOIN boards b ON b.id=a.board_id
    WHERE ${unreferenced} AND ${eligible} ORDER BY a.updated_at LIMIT $2`, [GRACE_HOURS, BATCH_SIZE]);
  let objectsDeleted = 0;
  for (const candidate of candidates) {
    const claimed = await transaction(pool, async (client) => {
      const board = await client.query('SELECT id FROM boards WHERE id=$1 FOR UPDATE SKIP LOCKED', [candidate.board_id]);
      if (!board.rowCount) return null;
      const { rows } = await client.query<{ id: string; storage_key: string }>(`
        SELECT a.id,a.storage_key FROM board_attachments a JOIN boards b ON b.id=a.board_id
        WHERE a.id=$2 AND ${unreferenced} AND ${eligible} FOR UPDATE OF a`, [GRACE_HOURS, candidate.id]);
      const attachment = rows[0];
      if (!attachment) return null;
      const uploads = await client.query<{ multipart_id: string | null }>(
        'SELECT multipart_id FROM attachment_uploads WHERE attachment_id=$1 FOR UPDATE', [attachment.id]);
      await client.query("UPDATE board_attachments SET state='deleting' WHERE id=$1", [attachment.id]);
      await client.query(`UPDATE attachment_uploads SET state='expired',basic_slot=false
        WHERE attachment_id=$1 AND state IN ('pending','uploading')`, [attachment.id]);
      return { ...attachment, uploads: uploads.rows };
    });
    if (!claimed) continue;
    for (const upload of claimed.uploads) {
      if (upload.multipart_id) await storage.abort(claimed.storage_key, upload.multipart_id);
    }
    await storage.delete(claimed.storage_key);
    await transaction(pool, async (client) => {
      await client.query('DELETE FROM attachment_uploads WHERE attachment_id=$1', [claimed.id]);
      await client.query("DELETE FROM board_attachments WHERE id=$1 AND state='deleting'", [claimed.id]);
    });
    objectsDeleted++;
  }
  let orphanUploads = 0;
  const oldest = Date.now() - GRACE_HOURS * 60 * 60 * 1000;
  for await (const upload of storage.uploads()) {
    if (upload.createdAt.getTime() >= oldest) continue;
    const active = await pool.query(`SELECT 1 FROM attachment_uploads u JOIN board_attachments a ON a.id=u.attachment_id
      JOIN boards b ON b.id=u.board_id
      WHERE a.storage_key=$1 AND u.multipart_id=$2 AND u.state IN ('pending','uploading')
        AND u.expires_at>now() AND b.deleted_at IS NULL`, [upload.key, upload.id]);
    if (!active.rowCount) {
      await storage.abort(upload.key, upload.id);
      orphanUploads++;
    }
  }
  return { expiredBoards, objectsDeleted, orphanUploads };
}

export function startAttachmentCleanup(pool: Pool, storage: ObjectStorage, log: FastifyBaseLogger) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try {
      const result = await cleanupAttachments(pool, storage);
      if (result.expiredBoards || result.objectsDeleted || result.orphanUploads) log.info(result, 'attachment_cleanup');
    } catch (error) {
      log.error({ diagnostic: safeDiagnostic(error) }, 'attachment_cleanup_failed');
    } finally {
      if (!stopped) timer = setTimeout(() => { running = tick(); }, 60_000);
    }
  };
  let running = tick();
  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
