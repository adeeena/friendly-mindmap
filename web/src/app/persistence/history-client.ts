import { BoardDoc } from '../core/model';
import { validateBoardDoc } from '../core/validate';
import { AuthSession, CloudRequestError } from './auth-client';

export interface HistoryItem {
  contentRevision: string;
  serverRevision: string;
  name: string;
  createdAt: number;
  current: boolean;
}

export interface HistoryAttachment {
  nodeId: string;
  id: string;
  name: string;
  mime: string;
  size: number;
  checksum: string | null;
  available: boolean;
}

export interface HistoryDetail extends HistoryItem {
  doc: BoardDoc;
  attachments: HistoryAttachment[];
}

export interface HistoryPage {
  items: HistoryItem[];
  nextBefore: string | null;
}

const revisionPattern = /^[1-9]\d{0,18}$/;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function item(value: unknown): HistoryItem {
  if (!object(value) || typeof value['contentRevision'] !== 'string' || !revisionPattern.test(value['contentRevision']) ||
      typeof value['serverRevision'] !== 'string' || !revisionPattern.test(value['serverRevision']) ||
      typeof value['name'] !== 'string' || typeof value['createdAt'] !== 'string' ||
      !Number.isFinite(Date.parse(value['createdAt'])) || typeof value['current'] !== 'boolean') {
    throw new Error('Invalid history entry');
  }
  return {
    contentRevision: value['contentRevision'], serverRevision: value['serverRevision'], name: value['name'],
    createdAt: Date.parse(value['createdAt']), current: value['current'],
  };
}

/** Private, session-bound transport for board history (owner-only on the server). */
export class CloudHistoryClient {
  private async request(path: string, session: AuthSession, signal: AbortSignal, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(path, {
      ...init, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      headers: { 'X-CSRF-Token': session.csrfToken, 'X-Session-Id': session.sessionId, ...init.headers },
    });
    if (!response.ok) {
      let code: string | undefined;
      try {
        const body: unknown = await response.json();
        const error = object(body) && object(body['error']) ? body['error']['code'] : undefined;
        if (typeof error === 'string') code = error;
      } catch { /* no structured error */ }
      throw new CloudRequestError(response.status, code);
    }
    return response.json();
  }

  async list(boardId: string, session: AuthSession, signal: AbortSignal, before?: string): Promise<HistoryPage> {
    const query = before ? `?before=${encodeURIComponent(before)}` : '';
    const value = await this.request(`/api/boards/${encodeURIComponent(boardId)}/history${query}`, session, signal);
    if (!object(value) || !Array.isArray(value['items']) ||
        (value['nextBefore'] !== null && (typeof value['nextBefore'] !== 'string' || !revisionPattern.test(value['nextBefore'])))) {
      throw new Error('Invalid history page');
    }
    return { items: value['items'].map(item), nextBefore: value['nextBefore'] };
  }

  async detail(boardId: string, contentRevision: string, session: AuthSession, signal: AbortSignal): Promise<HistoryDetail> {
    const value = await this.request(
      `/api/boards/${encodeURIComponent(boardId)}/history/${encodeURIComponent(contentRevision)}`, session, signal);
    if (!object(value) || !Array.isArray(value['attachments'])) throw new Error('Invalid history detail');
    const attachments = value['attachments'].map((entry: unknown): HistoryAttachment => {
      if (!object(entry) || typeof entry['nodeId'] !== 'string' || typeof entry['id'] !== 'string' ||
          typeof entry['name'] !== 'string' || typeof entry['mime'] !== 'string' || typeof entry['size'] !== 'number' ||
          !Number.isSafeInteger(entry['size']) || typeof entry['available'] !== 'boolean') throw new Error('Invalid history file');
      return {
        nodeId: entry['nodeId'], id: entry['id'], name: entry['name'], mime: entry['mime'], size: entry['size'],
        checksum: typeof entry['checksum'] === 'string' ? entry['checksum'] : null, available: entry['available'],
      };
    });
    const summary = item(value);
    if (summary.contentRevision !== contentRevision) throw new Error('History revision mismatch');
    return { ...summary, doc: validateBoardDoc(value['doc']), attachments };
  }

  async restore(
    boardId: string, contentRevision: string, expectedRevision: string, mutationId: string, session: AuthSession, signal: AbortSignal,
  ): Promise<void> {
    const value = await this.request(
      `/api/boards/${encodeURIComponent(boardId)}/history/${encodeURIComponent(contentRevision)}/restore`, session, signal, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mutationId, expectedRevision }),
      });
    if (!object(value) || value['id'] !== boardId || typeof value['revision'] !== 'string') throw new Error('Invalid restore acknowledgement');
  }
}
