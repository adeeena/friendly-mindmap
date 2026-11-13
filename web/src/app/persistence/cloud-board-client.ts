import { AttachmentMeta } from '../core/model';
import { AuthSession, CloudRequestError } from './auth-client';
import { PendingMutation } from './account-cache';
import { migrateBoard } from './migrations';
import { BoardRecord } from './board-repository';

export interface RemoteBoardSummary {
  id: string;
  name: string;
  revision: string;
  updatedAt: number;
  deletedAt: number | null;
}

export interface RemoteBoard {
  record: Omit<BoardRecord, 'revision'>;
  revision: string;
}

interface UploadState {
  state: 'pending' | 'uploading' | 'completed';
  partSize: number;
  parts: { number: number; size: number }[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function revision(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

export class CloudProtocolError extends Error {}

/** Private transport: credentials never enter the cache or the service worker. */
export class CloudBoardClient {
  private async request(path: string, session: AuthSession, signal: AbortSignal, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch('/api/boards' + (path.startsWith('?') ? '' : '/') + path, {
      ...init, credentials: 'same-origin', cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(init.body instanceof Blob ? 300_000 : 60_000)]),
      headers: { 'X-CSRF-Token': session.csrfToken, 'X-Session-Id': session.sessionId, ...init.headers },
    });
    if (!response.ok) {
      let code: string | undefined;
      if (response.headers.get('content-type')?.includes('application/json')) {
        const body: unknown = await response.json();
        if (object(body) && object(body['error']) && typeof body['error']['code'] === 'string') code = body['error']['code'];
      }

      throw new CloudRequestError(response.status, code);
    }
    return response.json();
  }

  async list(session: AuthSession, signal: AbortSignal): Promise<RemoteBoardSummary[]> {
    const value = await this.request('?includeDeleted=true', session, signal);
    if (!Array.isArray(value)) throw new CloudProtocolError('Invalid board listing');
    const ids = new Set<string>();
    return value.map((item: unknown) => {
      if (!object(item) || typeof item['id'] !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item['id']) ||
          ids.has(item['id']) || typeof item['name'] !== 'string' || !revision(item['revision']) ||
          typeof item['updatedAt'] !== 'string' || !Number.isFinite(Date.parse(item['updatedAt'])) ||
          (item['deletedAt'] !== null && (typeof item['deletedAt'] !== 'string' || !Number.isFinite(Date.parse(item['deletedAt']))))) {
        throw new CloudProtocolError('Invalid remote board metadata');
      }
      ids.add(item['id']);
      return {
        id: item['id'], name: item['name'], revision: item['revision'], updatedAt: Date.parse(item['updatedAt']),
        deletedAt: item['deletedAt'] === null ? null : Date.parse(item['deletedAt']),
      };
    });
  }

  async load(id: string, session: AuthSession, signal: AbortSignal): Promise<RemoteBoard | null> {
    let value: unknown;
    try { value = await this.request(id, session, signal); }
    catch (error) {
      if (error instanceof CloudRequestError && error.status === 404) return null;
      throw error;
    }
    if (!object(value) || value['id'] !== id || !revision(value['revision']) ||
        typeof value['updatedAt'] !== 'string' || !Number.isFinite(Date.parse(value['updatedAt'])) ||
        typeof value['schemaVersion'] !== 'number' || !Number.isInteger(value['schemaVersion']) || value['schemaVersion'] < 1) {
      throw new CloudProtocolError('Invalid remote board');
    }
    const board = migrateBoard(value);
    if (board.doc.id !== id || board.doc.name !== value['name']) throw new CloudProtocolError('Remote board identity mismatch');
    return {
      revision: value['revision'],
      record: { id, name: board.doc.name, doc: board.doc, camera: board.camera, schemaVersion: board.schemaVersion, updatedAt: Date.parse(value['updatedAt']) },
    };
  }

  async download(
    boardId: string, attachmentId: string, meta: AttachmentMeta, session: AuthSession, signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
    const response = await fetch(`/api/boards/${boardId}/attachments/${attachmentId}`, {
      credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
      headers: { 'X-Session-Id': session.sessionId },
    });
    if (!response.ok) throw new CloudRequestError(response.status);
    if (response.headers.get('content-length') !== String(meta.size) ||
        !/^[a-f0-9]{64}$/.test(response.headers.get('x-content-sha256') ?? '') || !response.body) {
      await response.body?.cancel();
      throw new CloudProtocolError('Invalid private attachment response');
    }
    return response.body;
  }

  async stage(id: string, session: AuthSession, signal: AbortSignal): Promise<void> {
    try {
      const value = await this.request(id + '/staging', session, signal, { method: 'POST' });
      if (!object(value) || value['id'] !== id || value['state'] !== 'staged') throw new CloudProtocolError('Invalid staging response');
    } catch (error) {
      // Publication may have committed just before a previous tab lost its response.
      if (!(error instanceof CloudRequestError) || error.status !== 409 || error.code !== 'REVISION_CONFLICT') throw error;
    }
  }

  async commit(operation: PendingMutation, session: AuthSession, signal: AbortSignal): Promise<string> {
    if (operation.state !== 'sending' || operation.expectedRevision === undefined) throw new Error('Mutation is not frozen');
    if (operation.kind === 'delete' && operation.expectedRevision === null) throw new Error('Cannot delete an unpublished server board');
    const record = operation.record;
    const board = record ? migrateBoard(record) : null;
    if (operation.kind === 'save' && (!board || board.doc.id !== operation.boardId)) throw new Error('Invalid pending board');
    const value = await this.request(operation.boardId, session, signal, {
      method: operation.kind === 'save' ? 'PUT' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mutationId: operation.mutationId, expectedRevision: operation.expectedRevision,
        ...(board ? { schemaVersion: board.schemaVersion, doc: board.doc, camera: board.camera } : {}),
      }),
    });
    if (!object(value) || value['id'] !== operation.boardId || !revision(value['revision'])) {
      throw new CloudProtocolError('Invalid board acknowledgement');
    }
    return value['revision'];
  }

  private uploadState(value: unknown, meta: AttachmentMeta): UploadState {
    const state = object(value) ? value['state'] : undefined;
    if (!object(value) || value['id'] !== meta.id || value['attachmentId'] !== meta.id || value['size'] !== meta.size ||
        (state !== 'pending' && state !== 'uploading' && state !== 'completed') ||
        typeof value['partSize'] !== 'number' || !Number.isSafeInteger(value['partSize']) ||
        value['partSize'] < 1 || value['partSize'] > 5 * 1024 ** 3 || !Array.isArray(value['parts'])) {
      throw new CloudProtocolError('Invalid upload response');
    }
    const parts: UploadState['parts'] = [];
    for (const part of value['parts']) {
      if (!object(part) || typeof part['number'] !== 'number' || !Number.isSafeInteger(part['number']) ||
          part['number'] < 1 || part['number'] > Math.max(1, Math.ceil(meta.size / value['partSize'])) ||
          typeof part['size'] !== 'number' ||
          part['size'] !== Math.min(value['partSize'], meta.size - (part['number'] - 1) * value['partSize']) ||
          parts.some((p) => p.number === part['number'])) throw new CloudProtocolError('Invalid uploaded part');
      parts.push({ number: part['number'], size: part['size'] });
    }
    if (value['state'] === 'completed') {
      const attachment = value['attachment'];
      if (!object(attachment) || attachment['id'] !== meta.id || attachment['name'] !== meta.name ||
          attachment['mime'] !== meta.mime || attachment['size'] !== meta.size ||
          typeof attachment['checksum'] !== 'string' || !/^[a-f0-9]{64}$/.test(attachment['checksum'])) {
        throw new CloudProtocolError('Invalid completed attachment');
      }
    }
    return { state, partSize: value['partSize'], parts };
  }

  async upload(
    boardId: string, nodeId: string, meta: AttachmentMeta, session: AuthSession, signal: AbortSignal,
    readPart: (offset: number, length: number) => Promise<Blob>,
    check: () => Promise<void>,
    progress?: (loaded: number) => void,
  ): Promise<void> {
    const path = `${boardId}/uploads/${meta.id}`;
    let upload = this.uploadState(await this.request(path, session, signal, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId, name: meta.name, mime: meta.mime, size: meta.size }),
    }), meta);
    if (upload.state === 'completed') { progress?.(meta.size); return; }
    await check();
    upload = this.uploadState(await this.request(path, session, signal), meta);
    if (upload.state === 'completed') { progress?.(meta.size); return; }
    const count = Math.max(1, Math.ceil(meta.size / upload.partSize));
    let loaded = upload.parts.reduce((sum, part) => sum + part.size, 0);
    progress?.(loaded);
    for (let number = 1; number <= count; number++) {
      if (upload.parts.some((part) => part.number === number)) continue;
      await check();
      const offset = (number - 1) * upload.partSize;
      const size = Math.min(upload.partSize, meta.size - offset);
      const blob = await readPart(offset, size);
      if (blob.size !== size) throw new Error('Cached upload part has the wrong byte count');
      await check();
      const part = await this.request(`${path}/parts/${number}`, session, signal, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: blob,
      });
      if (!object(part) || part['number'] !== number || part['size'] !== size ||
          typeof part['etag'] !== 'string' || !part['etag']) throw new CloudProtocolError('Invalid part acknowledgement');
      loaded += size;
      progress?.(loaded);
    }
    await check();
    upload = this.uploadState(await this.request(path + '/complete', session, signal, { method: 'POST' }), meta);
    if (upload.state !== 'completed') throw new CloudProtocolError('Attachment was not finalized');
  }
}
