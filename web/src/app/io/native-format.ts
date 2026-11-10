import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { AttachmentMeta, BoardDoc, Camera, SCHEMA_VERSION, StoredBoard } from '../core/model';
import { BoardValidationError } from '../core/validate';
import { NewerSchemaError, migrateBoard } from '../persistence/migrations';

export const NATIVE_FORMAT = 'better-mindmap';
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

export interface NativeFile {
  format: typeof NATIVE_FORMAT;
  schemaVersion: number;
  board: { doc: BoardDoc; camera: Camera };
  attachments: (AttachmentMeta & { path?: string })[];
}

export interface ImportedBoard {
  board: StoredBoard;
  files: { meta: AttachmentMeta; blob: Blob }[];
}

function allAttachments(doc: BoardDoc): AttachmentMeta[] {
  return Object.values(doc.nodes).flatMap((n) => n.attachments ?? []);
}

export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 120) || 'board';
}

export function toNativeJson(doc: BoardDoc, camera: Camera): string {
  const file: NativeFile = {
    format: NATIVE_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    board: { doc, camera },
    attachments: allAttachments(doc),
  };
  return JSON.stringify(file, null, 2);
}

export async function toNativeZip(
  doc: BoardDoc,
  camera: Camera,
  getBlob: (id: string) => Promise<Blob | null>,
): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  const metas = allAttachments(doc);
  const withPaths: NativeFile['attachments'] = [];
  for (const m of metas) {
    const blob = await getBlob(m.id);
    if (!blob) {
      withPaths.push(m);
      continue;
    }
    const path = `attachments/${m.id}`;
    entries[path] = new Uint8Array(await blob.arrayBuffer());
    withPaths.push({ ...m, path });
  }
  const file: NativeFile = {
    format: NATIVE_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    board: { doc, camera },
    attachments: withPaths,
  };
  entries['board.json'] = strToU8(JSON.stringify(file));
  return zipSync(entries, { level: 6 });
}

function parseNativeObject(raw: unknown): StoredBoard {
  if (!raw || typeof raw !== 'object') throw new BoardValidationError('Not a board file');
  const f = raw as Record<string, unknown>;
  if (f['format'] !== NATIVE_FORMAT) throw new BoardValidationError('Not a Better Mindmap file');
  const board = f['board'] as Record<string, unknown> | undefined;
  try {
    return migrateBoard({ schemaVersion: f['schemaVersion'], doc: board?.['doc'], camera: board?.['camera'] });
  } catch (e) {
    if (e instanceof NewerSchemaError) throw new BoardValidationError('This file was made by a newer version of the app.');
    throw e;
  }
}

export async function importBoardFile(file: Blob & { name?: string }): Promise<ImportedBoard> {
  if (file.size > MAX_IMPORT_BYTES) throw new BoardValidationError('File is larger than 50 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) {
    let raw: unknown;
    try {
      raw = JSON.parse(strFromU8(bytes));
    } catch {
      throw new BoardValidationError('File is not valid JSON.');
    }
    return { board: parseNativeObject(raw), files: [] };
  }
  let total = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        total += f.originalSize;
        if (total > MAX_IMPORT_BYTES) throw new BoardValidationError('Archive expands beyond 50 MB.');
        return f.name === 'board.json' || f.name.startsWith('attachments/');
      },
    });
  } catch (e) {
    if (e instanceof BoardValidationError) throw e;
    throw new BoardValidationError('Archive is corrupt.');
  }
  const json = entries['board.json'];
  if (!json) throw new BoardValidationError('Archive has no board.json.');
  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(json));
  } catch {
    throw new BoardValidationError('board.json is not valid JSON.');
  }
  const board = parseNativeObject(raw);
  const metas = (raw as NativeFile).attachments ?? [];
  const known = new Map(Object.values(board.doc.nodes).flatMap((n) => n.attachments ?? []).map((a) => [a.id, a]));
  const files: ImportedBoard['files'] = [];
  for (const m of Array.isArray(metas) ? metas : []) {
    const meta = known.get(m?.id);
    const data = m?.path ? entries[m.path] : undefined;
    if (meta && data) files.push({ meta, blob: new Blob([data as BlobPart], { type: meta.mime }) });
  }
  return { board, files };
}
