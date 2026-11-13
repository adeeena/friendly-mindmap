/**
 * @jest-environment node
 */
import { randomUUID } from 'node:crypto';
import { createBoard, SCHEMA_VERSION } from '../core/model';
import { AuthSession, CloudRequestError } from './auth-client';
import { PendingMutation } from './account-cache';
import { CloudBoardClient, CloudProtocolError } from './cloud-board-client';

const authenticated: AuthSession = {
  account: { id: randomUUID(), role: 'admin', username: 'test', display_name: 'Test' },
  sessionId: randomUUID(), csrfToken: 'c'.repeat(64), expiresAt: '2099-01-01T00:00:00Z',
};
const signal = new AbortController().signal;
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('same-origin cloud transport', () => {
  const original = globalThis.fetch;
  const request = jest.fn<Promise<Response>, [string, RequestInit]>();
  const client = new CloudBoardClient();
  beforeEach(() => { request.mockReset(); globalThis.fetch = request; });
  afterAll(() => { globalThis.fetch = original; });

  it('validates remote metadata and binds private reads to the captured session', async () => {
    const id = randomUUID();
    const updatedAt = '2026-11-12T10:00:00.000Z';
    const summary = { id, name: 'Remote', revision: '9007199254740993', updatedAt, deletedAt: null };
    request.mockResolvedValueOnce(response([summary]));
    expect(await client.list(authenticated, signal)).toEqual([{ ...summary, updatedAt: Date.parse(updatedAt) }]);
    expect(request.mock.calls[0]![0]).toBe('/api/boards?includeDeleted=true');
    expect(request.mock.calls[0]![1].headers).toMatchObject({ 'X-Session-Id': authenticated.sessionId });
    request.mockResolvedValueOnce(response([summary, summary]));
    await expect(client.list(authenticated, signal)).rejects.toBeInstanceOf(CloudProtocolError);
    request.mockResolvedValueOnce(response({ ...summary, schemaVersion: SCHEMA_VERSION, doc: createBoard('Remote', id), camera: { x: 0, y: 0, zoom: 1 } }));
    expect((await client.load(id, authenticated, signal))?.record.name).toBe('Remote');
    request.mockResolvedValueOnce(response({ ...summary, schemaVersion: SCHEMA_VERSION, doc: createBoard('Wrong identity'), camera: { x: 0, y: 0, zoom: 1 } }));
    await expect(client.load(id, authenticated, signal)).rejects.toBeInstanceOf(CloudProtocolError);
  });

  it('returns a private download stream only after validating declared size and checksum headers', async () => {
    const meta = { id: randomUUID(), name: 'file.txt', mime: 'text/plain', size: 3 };
    request.mockResolvedValueOnce(new Response('abc', {
      headers: { 'Content-Length': '3', 'X-Content-SHA256': 'a'.repeat(64) },
    }));
    const stream = await client.download(randomUUID(), meta.id, meta, authenticated, signal);
    expect(await new Response(stream).text()).toBe('abc');
    expect(request.mock.calls[0]![1].headers).toEqual({ 'X-Session-Id': authenticated.sessionId });
    request.mockResolvedValueOnce(new Response('abc', { headers: { 'Content-Length': '4' } }));
    await expect(client.download(randomUUID(), meta.id, meta, authenticated, signal)).rejects.toBeInstanceOf(CloudProtocolError);
  });

  it('resumes acknowledged parts without reading them and validates byte-complete finalization', async () => {
    const board = randomUUID();
    const partSize = 8 * 1024 * 1024;
    const meta = { id: randomUUID(), name: 'large.bin', mime: 'application/octet-stream', size: partSize + 19 };
    const upload = { id: meta.id, attachmentId: meta.id, state: 'uploading', size: meta.size, partSize, parts: [] };
    const completed = { ...upload, state: 'completed', attachment: { ...meta, checksum: 'a'.repeat(64) } };
    request.mockResolvedValueOnce(response(upload))
      .mockResolvedValueOnce(response({ ...upload, parts: [{ number: 1, size: partSize, etag: 'etag1' }] }))
      .mockResolvedValueOnce(response({ number: 2, size: 19, etag: 'etag2' }))
      .mockResolvedValueOnce(response(completed));
    const read = jest.fn(async (_offset, length) => new Blob([new Uint8Array(length)]));
    const check = jest.fn().mockResolvedValue(undefined);
    await client.upload(board, 'node', meta, authenticated, signal, read, check);
    expect(read.mock.calls).toEqual([[partSize, 19]]);
    expect(request.mock.calls.map(([url, init]) => [url, init.method ?? 'GET'])).toEqual([
      [`/api/boards/${board}/uploads/${meta.id}`, 'POST'],
      [`/api/boards/${board}/uploads/${meta.id}`, 'GET'],
      [`/api/boards/${board}/uploads/${meta.id}/parts/2`, 'PUT'],
      [`/api/boards/${board}/uploads/${meta.id}/complete`, 'POST'],
    ]);
    for (const [, init] of request.mock.calls) {
      expect(init.credentials).toBe('same-origin');
      expect(init.cache).toBe('no-store');
      expect(init.headers).toMatchObject({ 'X-CSRF-Token': authenticated.csrfToken });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(request.mock.calls[2]![1].body).toBeInstanceOf(Blob);
    expect(check).toHaveBeenCalled();
  });

  it('retries completed upload identities without sending bytes a second time', async () => {
    const meta = { id: randomUUID(), name: 'empty', mime: 'application/octet-stream', size: 0 };
    request.mockResolvedValue(response({
      id: meta.id, attachmentId: meta.id, size: 0, state: 'completed', partSize: 8 * 1024 * 1024,
      parts: [], attachment: { ...meta, checksum: 'a'.repeat(64) },
    }));
    const read = jest.fn();
    await client.upload(randomUUID(), 'node', meta, authenticated, signal, read, jest.fn());
    expect(request).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });

  it('transfers a real zero-byte part before finalizing an empty file', async () => {
    const meta = { id: randomUUID(), name: 'empty', mime: 'application/octet-stream', size: 0 };
    const info = { id: meta.id, attachmentId: meta.id, size: 0, state: 'uploading', partSize: 8 * 1024 * 1024, parts: [] };
    request.mockResolvedValueOnce(response(info)).mockResolvedValueOnce(response(info))
      .mockResolvedValueOnce(response({ number: 1, size: 0, etag: 'empty' }))
      .mockResolvedValueOnce(response({ ...info, state: 'completed', attachment: { ...meta, checksum: 'a'.repeat(64) } }));
    const read = jest.fn().mockResolvedValue(new Blob([]));
    await client.upload(randomUUID(), 'node', meta, authenticated, signal, read, jest.fn());
    expect(read).toHaveBeenCalledWith(0, 0);
    expect(request.mock.calls[2]![1].body).toEqual(new Blob([]));
  });

  it('preserves frozen board mutation IDs and expected decimal revisions on retries', async () => {
    const doc = createBoard('Retry');
    const operation: PendingMutation = {
      id: 1, mutationId: randomUUID(), boardId: doc.id, sequence: 3, kind: 'save', state: 'sending',
      expectedRevision: '9007199254740993',
      record: { id: doc.id, name: doc.name, doc, camera: { x: 0, y: 0, zoom: 1 }, schemaVersion: SCHEMA_VERSION, updatedAt: 1 },
    };
    request.mockImplementation(async () => response({ id: doc.id, revision: '9007199254740994' }));
    expect(await client.commit(operation, authenticated, signal)).toBe('9007199254740994');
    expect(await client.commit(operation, authenticated, signal)).toBe('9007199254740994');
    const first = request.mock.calls[0]![1].body;
    expect(first).toBe(request.mock.calls[1]![1].body);
    expect(JSON.parse(String(first))).toMatchObject({ mutationId: operation.mutationId, expectedRevision: '9007199254740993' });
  });

  it.each([{ id: randomUUID(), revision: '2' }, { revision: 2 }, { revision: '0' }, { revision: '9223372036854775808' }])(
    'rejects malformed or wrong-board acknowledgements: %j', async (value) => {
      const doc = createBoard('Pending');
      const operation: PendingMutation = {
        id: 1, mutationId: randomUUID(), boardId: doc.id, sequence: 1, kind: 'save', state: 'sending', expectedRevision: null,
        record: { id: doc.id, name: doc.name, doc, camera: { x: 0, y: 0, zoom: 1 }, schemaVersion: SCHEMA_VERSION, updatedAt: 1 },
      };
      request.mockResolvedValue(response({ id: doc.id, ...value }));
      await expect(client.commit(operation, authenticated, signal)).rejects.toBeInstanceOf(CloudProtocolError);
    });

  it('accepts a staging conflict only as a possible lost publication response, never swallowing unrelated failures', async () => {
    request.mockResolvedValueOnce(response({ error: { code: 'REVISION_CONFLICT' } }, 409));
    await client.stage(randomUUID(), authenticated, signal);
    request.mockResolvedValueOnce(response({ error: { code: 'UPLOAD_MISMATCH' } }, 409));
    await expect(client.stage(randomUUID(), authenticated, signal)).rejects.toMatchObject({ status: 409, code: 'UPLOAD_MISMATCH' });
    request.mockResolvedValueOnce(response({ error: { code: 'AUTH_REQUIRED' } }, 401));
    await expect(client.stage(randomUUID(), authenticated, signal)).rejects.toBeInstanceOf(CloudRequestError);
  });

  it('cannot call completion when a part response is lost, and keeps the original upload identity on retry', async () => {
    const meta = { id: randomUUID(), name: 'file', mime: 'text/plain', size: 3 };
    const info = { id: meta.id, attachmentId: meta.id, size: 3, state: 'uploading', partSize: 8 * 1024 * 1024, parts: [] };
    request.mockResolvedValueOnce(response(info)).mockResolvedValueOnce(response(info)).mockRejectedValueOnce(new TypeError('Lost response'));
    const read = jest.fn().mockResolvedValue(new Blob(['abc']));
    const board = randomUUID();
    await expect(client.upload(board, 'node', meta, authenticated, signal, read, jest.fn())).rejects.toThrow('Lost response');
    expect(request.mock.calls.some(([url]) => url.endsWith('/complete'))).toBe(false);
    request.mockResolvedValueOnce(response(info))
      .mockResolvedValueOnce(response({ ...info, parts: [{ number: 1, size: 3 }] }))
      .mockResolvedValueOnce(response({ ...info, state: 'completed', attachment: { ...meta, checksum: 'a'.repeat(64) } }));
    await client.upload(board, 'node', meta, authenticated, signal, read, jest.fn());
    expect(read).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe(request.mock.calls[3]![0]);
  });
});
