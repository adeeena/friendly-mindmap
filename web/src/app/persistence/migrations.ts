import { SCHEMA_VERSION, StoredBoard } from '../core/model';
import { BoardValidationError, validateBoardDoc, validateCamera } from '../core/validate';

type RawBoard = Record<string, unknown>;

/** Ordered upgrades: MIGRATIONS[n] converts schema n to n + 1. */
export const MIGRATIONS: Record<number, (raw: RawBoard) => RawBoard> = {};

export class NewerSchemaError extends Error {
  constructor(readonly version: number) {
    super(`Board uses schema version ${version}, newer than supported ${SCHEMA_VERSION}`);
  }
}

/**
 * Upgrades stored/imported data to the current schema and validates it.
 * Throws NewerSchemaError for unknown future versions.
 */
export function migrateBoard(input: unknown, migrations = MIGRATIONS, current = SCHEMA_VERSION): StoredBoard {
  if (!input || typeof input !== 'object') throw new BoardValidationError('Invalid board record');
  let raw = { ...(input as RawBoard) };
  let version = typeof raw['schemaVersion'] === 'number' ? (raw['schemaVersion'] as number) : 1;
  if (version > current) throw new NewerSchemaError(version);
  while (version < current) {
    const step = migrations[version];
    if (!step) throw new BoardValidationError(`No migration from schema ${version}`);
    raw = step(raw);
    version++;
  }
  return {
    schemaVersion: current,
    revision: typeof raw['revision'] === 'number' ? (raw['revision'] as number) : 0,
    updatedAt: typeof raw['updatedAt'] === 'number' ? (raw['updatedAt'] as number) : Date.now(),
    doc: validateBoardDoc(raw['doc']),
    camera: validateCamera(raw['camera']),
  };
}
