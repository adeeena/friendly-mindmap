import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FastifyInstance } from 'fastify';
import { Pool, PoolClient } from 'pg';
import { BASIC_ATTACHMENT_BYTES } from '../../shared/attachment-policy';
import { Authentication } from './auth';
import { Account } from './credentials';
import { transaction } from './database';
import { ApiError } from './errors';
import { activeAccount, objectBody, ownedBoard, uuid } from './guards';
import { ObjectStorage, storageMissing } from './object-storage';

const MiB = 1024 * 1024;
const UPLOAD_LIFETIME_SECONDS = 24 * 60 * 60;

interface Upload {
  id: string;
  attachment_id: string;
  board_id: string;
  owner_id: string;
  node_id: string;
  multipart_id: string | null;
  expected_size: string;
  state: 'pending' | 'uploading' | 'completed' | 'aborted' | 'expired';
  expires_at: Date;
  storage_key: string;
  name: string;
  mime: string;
  size_bytes: string | null;
  checksum: string | null;
}

interface UploadParams { boardId: string; uploadId: string }

export function uploadPartSize(size: number): number {
  const partSize = Math.max(8 * MiB, Math.ceil(size / 10_000 / MiB) * MiB);
  if (partSize > 5 * 1024 * MiB) {
    throw new ApiError(422, 'STORAGE_LIMIT', 'This file exceeds the S3 provider multipart limits.');
  }
  return partSize;
}

function assertSize(account: Account, size: number): void {
  if (account.role === 'basic' && size > BASIC_ATTACHMENT_BYTES) {
    throw new ApiError(422, 'ATTACHMENT_SIZE', 'Basic users can attach files up to 5 MiB.');
  }
}

async function uploadRecord(client: PoolClient, account: Account, params: UploadParams): Promise<Upload> {
  await ownedBoard(client, account.id, params.boardId, true, false, true);
  const { rows } = await client.query<Upload>(`
    SELECT u.*,a.storage_key,a.name,a.mime,a.size_bytes,a.checksum
    FROM attachment_uploads u JOIN board_attachments a ON a.id=u.attachment_id
    WHERE u.id=$1 AND u.board_id=$2 AND u.owner_id=$3 FOR UPDATE OF u,a`,
  [uuid(params.uploadId), uuid(params.boardId), account.id]);
  const upload = rows[0];
  if (!upload) throw new ApiError(404, 'NOT_FOUND', 'The requested upload was not found.');
  return upload;
}

function assertLive(upload: Upload): void {
  if (['aborted', 'expired'].includes(upload.state) || (upload.state !== 'completed' && upload.expires_at <= new Date())) {
    throw new ApiError(410, 'UPLOAD_EXPIRED', 'This upload expired or was cancelled; start a new upload.');
  }
}

function uploadResult(upload: Upload, parts: readonly { number: number; etag: string; size: number }[] = []) {
  return {
    id: upload.id, attachmentId: upload.attachment_id, state: upload.state,
    size: Number(upload.expected_size), partSize: uploadPartSize(Number(upload.expected_size)),
    expiresAt: upload.expires_at.toISOString(), parts,
    attachment: upload.state === 'completed' ? {
      id: upload.attachment_id, name: upload.name, mime: upload.mime, size: Number(upload.size_bytes),
      checksum: upload.checksum,
    } : null,
  };
}

async function initialize(client: PoolClient, upload: Upload, storage: ObjectStorage): Promise<void> {
  if (upload.multipart_id || upload.state === 'completed') return;
  upload.multipart_id = await storage.begin(upload.storage_key);
  upload.state = 'uploading';
  await client.query("UPDATE attachment_uploads SET multipart_id=$2,state='uploading' WHERE id=$1", [upload.id, upload.multipart_id]);
}

async function assertSlot(
  client: PoolClient, account: Account, boardId: string, nodeId: string, upload?: Upload,
): Promise<void> {
  if (account.role === 'admin') return;
  const { rows } = await client.query<{ occupied: boolean }>(`SELECT
    EXISTS (SELECT 1 FROM board_attachment_refs WHERE board_id=$1 AND node_id=$2
      AND ($3::uuid IS NULL OR attachment_id<>$3))
    OR EXISTS (SELECT 1 FROM attachment_uploads WHERE board_id=$1 AND node_id=$2
      AND basic_slot AND state IN ('pending','uploading','completed') AND expires_at>now()
      AND ($4::uuid IS NULL OR id<>$4)) AS occupied`, [boardId, nodeId, upload?.attachment_id ?? null, upload?.id ?? null]);
  if (rows[0]?.occupied) throw new ApiError(422, 'ATTACHMENT_COUNT', 'Basic users can attach one file per block.');
}

async function assertUploadPolicy(client: PoolClient, account: Account, upload: Upload): Promise<void> {
  assertSize(account, Number(upload.expected_size));
  await assertSlot(client, account, upload.board_id, upload.node_id, upload);
  if (account.role === 'basic') {
    await client.query(`UPDATE attachment_uploads SET basic_slot=NOT EXISTS
      (SELECT 1 FROM board_attachment_refs WHERE attachment_id=$2) WHERE id=$1`, [upload.id, upload.attachment_id]);
  }
}

export function registerUploads(app: FastifyInstance, pool: Pool, auth: Authentication, storage: ObjectStorage): void {
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
  const path = '/api/boards/:boardId/uploads/:uploadId';

  app.post<{ Params: UploadParams }>(path, async (request) => {
    const { account } = await auth.requireSession(request, true);
    const boardId = uuid(request.params.boardId);
    const uploadId = uuid(request.params.uploadId);
    const body = objectBody(request.body);
    const { nodeId, name, mime, size } = body;
    if (Object.keys(body).some((key) => !['nodeId', 'name', 'mime', 'size'].includes(key)) ||
      typeof nodeId !== 'string' || !nodeId || nodeId.length > 200 ||
      typeof name !== 'string' || !name || name.length > 255 || /[\x00-\x1f\x7f]/.test(name) ||
      typeof mime !== 'string' || !mime || mime.length > 255 || /[\x00-\x1f\x7f]/.test(mime) ||
      typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      throw new ApiError(400, 'INVALID_UPLOAD', 'Upload node, filename, media type and byte size are required.');
    }
    uploadPartSize(size);
    await transaction(pool, async (client) => {
      const current = await activeAccount(client, account.id);
      await ownedBoard(client, current.id, boardId, true, false, true);
      assertSize(current, size);
      const previous = await client.query('SELECT id FROM attachment_uploads WHERE id=$1', [uploadId]);
      if (previous.rowCount) {
        const upload = await uploadRecord(client, current, request.params);
        if (upload.node_id !== nodeId || upload.name !== name || upload.mime !== mime || upload.expected_size !== String(size)) {
          throw new ApiError(409, 'UPLOAD_MISMATCH', 'The upload identity was already used for a different file.');
        }
        assertLive(upload);
        return;
      }
      await client.query(`UPDATE attachment_uploads SET state='expired',basic_slot=false
        WHERE board_id=$1 AND state IN ('pending','uploading') AND expires_at<=now()`, [boardId]);
      await assertSlot(client, current, boardId, nodeId);
      const attachmentId = uploadId;
      await client.query(`INSERT INTO board_attachments
        (id,board_id,owner_id,uploader_id,storage_key,name,mime,state)
        VALUES ($1,$2,$3,$3,$4,$5,$6,'staged')`,
      [attachmentId, boardId, current.id, `${boardId}/${attachmentId}`, name, mime]);
      await client.query(`INSERT INTO attachment_uploads
        (id,attachment_id,board_id,owner_id,node_id,expected_size,state,basic_slot,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,now()+make_interval(secs=>$8))`,
      [uploadId, attachmentId, boardId, current.id, nodeId, size, current.role === 'basic', UPLOAD_LIFETIME_SECONDS]);
      await client.query('UPDATE boards SET updated_at=now() WHERE id=$1 AND is_staged', [boardId]);
    });
    return transaction(pool, async (client) => {
      const current = await activeAccount(client, account.id);
      const upload = await uploadRecord(client, current, request.params);
      assertLive(upload);
      await initialize(client, upload, storage);
      return uploadResult(upload);
    });
  });

  app.get<{ Params: UploadParams }>(path, async (request) => {
    const { account } = await auth.requireSession(request);
    return transaction(pool, async (client) => {
      const current = await activeAccount(client, account.id);
      const upload = await uploadRecord(client, current, request.params);
      assertLive(upload);
      const parts = upload.state === 'uploading' && upload.multipart_id
        ? await storage.parts(upload.storage_key, upload.multipart_id) : [];
      return uploadResult(upload, parts);
    });
  });

  app.put<{ Params: UploadParams & { part: string } }>(`${path}/parts/:part`, async (request) => {
    const { account } = await auth.requireSession(request, true);
    if (!(request.body instanceof Readable) || !/^[1-9]\d{0,3}$|^10000$/.test(request.params.part)) {
      throw new ApiError(400, 'INVALID_PART', 'A binary upload part and valid part number are required.');
    }
    const source = request.body;
    return transaction(pool, async (client) => {
      const current = await activeAccount(client, account.id);
      const upload = await uploadRecord(client, current, request.params);
      assertLive(upload);
      await assertUploadPolicy(client, current, upload);
      if (upload.state !== 'uploading' || !upload.multipart_id) {
        throw new ApiError(409, 'UPLOAD_STATE', 'This upload is not accepting parts.');
      }
      const number = Number(request.params.part);
      const size = Number(upload.expected_size);
      const partSize = uploadPartSize(size);
      const count = Math.max(1, Math.ceil(size / partSize));
      const expected = Math.min(partSize, size - (number - 1) * partSize);
      if (number > count || request.headers['content-length'] !== String(expected)) {
        throw new ApiError(400, 'INVALID_PART', 'The part size or part number does not match the upload.');
      }
      let actual = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          actual += chunk.length;
          callback(actual > expected ? new ApiError(422, 'PART_SIZE', 'The part exceeds its declared byte size.') : null, chunk);
        },
        flush(callback) {
          callback(actual === expected ? null : new ApiError(422, 'PART_SIZE', 'The part is incomplete; retry it.'));
        },
      });
      const input = Readable.from(source.iterator({ destroyOnReturn: false }), {
        objectMode: false, highWaterMark: 64 * 1024,
      });
      const flowing = pipeline(input, meter);
      const controller = new AbortController();
      const writing = storage.part(upload.storage_key, upload.multipart_id, number, expected, meter, controller.signal);
      let etag: string;
      try {
        [, etag] = await Promise.all([flowing, writing]);
      } catch (error) {
        controller.abort();
        meter.destroy();
        source.resume();
        await Promise.allSettled([flowing, writing]);
        throw error;
      }
      const parts = await storage.parts(upload.storage_key, upload.multipart_id);
      await client.query(`UPDATE attachment_uploads SET completed_parts=$2::jsonb,
        expires_at=now()+make_interval(secs=>$3) WHERE id=$1`, [upload.id, JSON.stringify(parts), UPLOAD_LIFETIME_SECONDS]);
      await client.query('UPDATE boards SET updated_at=now() WHERE id=$1 AND is_staged', [upload.board_id]);
      return { number, size: actual, etag };
    });
  });

  app.post<{ Params: UploadParams }>(`${path}/complete`, async (request) => {
    const { account } = await auth.requireSession(request, true);
    return transaction(pool, async (client) => {
      const current = await activeAccount(client, account.id);
      const upload = await uploadRecord(client, current, request.params);
      assertLive(upload);
      await assertUploadPolicy(client, current, upload);
      if (upload.state === 'completed') return uploadResult(upload);
      if (!upload.multipart_id) throw new ApiError(409, 'UPLOAD_STATE', 'Upload parts before completing this file.');
      let objectExists = false;
      try { await storage.head(upload.storage_key); objectExists = true; }
      catch (error) { if (!storageMissing(error)) throw error; }
      if (!objectExists) {
        const parts = await storage.parts(upload.storage_key, upload.multipart_id);
        const size = Number(upload.expected_size);
        const partSize = uploadPartSize(size);
        const count = Math.max(1, Math.ceil(size / partSize));
        if (parts.length !== count || parts.some((part, index) =>
          part.number !== index + 1 || part.size !== Math.min(partSize, size - index * partSize))) {
          throw new ApiError(422, 'UPLOAD_INCOMPLETE', 'Some file parts are missing or incomplete; resume the upload.');
        }
        await storage.complete(upload.storage_key, upload.multipart_id, parts);
      }
      const object = await storage.download(upload.storage_key);
      const hash = createHash('sha256');
      let actual = 0;
      for await (const chunk of object.body) {
        actual += Buffer.byteLength(chunk);
        if (actual > Number(upload.expected_size)) {
          object.body.destroy();
          throw new ApiError(422, 'ATTACHMENT_SIZE', 'Stored bytes exceed the declared file size.');
        }
        hash.update(chunk);
      }
      assertSize(current, actual);
      if (actual !== Number(upload.expected_size)) throw new ApiError(422, 'UPLOAD_INCOMPLETE', 'Stored bytes do not match the declared file size.');
      upload.size_bytes = String(actual);
      upload.checksum = hash.digest('hex');
      upload.state = 'completed';
      await client.query(`UPDATE board_attachments SET state='ready',size_bytes=$2,checksum=$3,updated_at=now() WHERE id=$1`,
        [upload.attachment_id, upload.size_bytes, upload.checksum]);
      await client.query("UPDATE attachment_uploads SET state='completed' WHERE id=$1", [upload.id]);
      return uploadResult(upload);
    });
  });

  app.delete<{ Params: UploadParams }>(path, async (request) => {
    const { account } = await auth.requireSession(request, true);
    return transaction(pool, async (client) => {
      const current = await activeAccount(client, account.id);
      const upload = await uploadRecord(client, current, request.params);
      const refs = await client.query(`SELECT 1 FROM board_attachment_refs WHERE attachment_id=$1
        UNION ALL SELECT 1 FROM board_history_attachments WHERE attachment_id=$1 LIMIT 1`, [upload.attachment_id]);
      if (refs.rowCount) throw new ApiError(409, 'ATTACHMENT_REFERENCED', 'Remove the file through a board save; retained history may still reference it.');
      if (upload.multipart_id) {
        try { await storage.abort(upload.storage_key, upload.multipart_id); }
        catch (error) { if (!storageMissing(error)) throw error; }
      }
      await storage.delete(upload.storage_key);
      await client.query("UPDATE attachment_uploads SET state='aborted',basic_slot=false WHERE id=$1", [upload.id]);
      await client.query("UPDATE board_attachments SET state='deleting',updated_at=now() WHERE id=$1", [upload.attachment_id]);
      return { id: upload.id, state: 'aborted' };
    });
  });
}
