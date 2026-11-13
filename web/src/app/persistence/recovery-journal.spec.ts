/**
 * @jest-environment node
 */
import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { createBoard, SCHEMA_VERSION } from '../core/model';
import { AccountBoardCache } from './account-cache';
import { BoardRecord, BoardSaveResult, MemoryBoardRepository } from './board-repository';
import { RecoveryJournal } from './recovery-journal';

class TestStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function snapshot(id: string, name: string) {
  return {
    id, name, doc: createBoard(name, id), camera: { x: 0, y: 0, zoom: 1 },
    updatedAt: Date.now(), schemaVersion: SCHEMA_VERSION,
  };
}
const guest = { kind: 'guest' } as const;
const copyName = (name: string) => name + ' (recovered)';

class PersistentRepository extends MemoryBoardRepository {
  override readonly localDurability = 'persistent' as const;
  override async save(record: Omit<BoardRecord, 'revision'>, expectedRevision: number | null): Promise<BoardSaveResult> {
    return { ...await super.save(record, expectedRevision), localDurability: 'persistent' };
  }
}

describe('workspace recovery journal', () => {
  it('synchronously journals the latest edit and recovers a stale existing board without time comparisons', async () => {
    const storage = new TestStorage();
    const repo = new PersistentRepository();
    await repo.save(snapshot('board', 'Old'), null);
    const journal = new RecoveryJournal(storage, guest);
    const latest = snapshot('board', 'Latest');
    latest.updatedAt = 1;
    journal.capture(latest, 1);
    expect(storage.length).toBe(1);
    const reopened = new RecoveryJournal(storage, guest);
    expect(await reopened.recover(repo, copyName)).toEqual({ lastId: 'board', conflicts: [] });
    expect((await repo.load('board'))?.name).toBe('Latest');
    expect(storage.length).toBe(0);
  });

  it('an older acknowledgement rebases but never removes the latest snapshot', async () => {
    const storage = new TestStorage();
    const repo = new PersistentRepository();
    await repo.save(snapshot('board', 'Old'), null);
    const journal = new RecoveryJournal(storage, guest);
    const first = journal.capture(snapshot('board', 'First'), 1);
    journal.capture(snapshot('board', 'Second'), 1);
    await repo.save(first.record, 1);
    journal.acknowledge(first, 2);
    expect(journal.entries()[0]).toMatchObject({ sequence: 2, baseRevision: 2, record: { name: 'Second' } });
    await new RecoveryJournal(storage, guest).recover(repo, copyName);
    expect((await repo.load('board'))?.name).toBe('Second');
    expect(storage.length).toBe(0);
  });

  it('clears only acknowledged entries and tolerates a crash between IndexedDB commit and journal cleanup', async () => {
    const storage = new TestStorage();
    const repo = new PersistentRepository();
    await repo.save(snapshot('board', 'Old'), null);
    const journal = new RecoveryJournal(storage, guest);
    const entry = journal.capture(snapshot('board', 'Committed'), 1);
    await repo.save(entry.record, 1);
    await new RecoveryJournal(storage, guest).recover(repo, copyName);
    expect((await repo.load('board'))?.revision).toBe(2);
    expect(await repo.list()).toHaveLength(1);
    expect(storage.length).toBe(0);
  });

  it('preserves a concurrent original and uses a stable recovery copy identity', async () => {
    const storage = new TestStorage();
    const repo = new PersistentRepository();
    await repo.save(snapshot('board', 'Old'), null);
    const journal = new RecoveryJournal(storage, guest);
    const entry = journal.capture(snapshot('board', 'Mine'), 1);
    await repo.save(snapshot('board', 'Theirs'), 1);
    const remove = jest.spyOn(storage, 'removeItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    await expect(journal.recover(repo, copyName)).rejects.toThrow('Storage unavailable');
    remove.mockRestore();
    expect((await repo.load('board'))?.name).toBe('Theirs');
    expect((await repo.load(entry.recoveryId))?.name).toBe('Mine (recovered)');
    await journal.recover(repo, copyName);
    expect(await repo.list()).toHaveLength(2);
    expect(storage.length).toBe(0);
  });

  it('never resurrects a deleted board and clears all tab snapshots on explicit discard', async () => {
    const storage = new TestStorage();
    const repo = new PersistentRepository();
    await repo.save(snapshot('board', 'Old'), null);
    const journal = new RecoveryJournal(storage, guest);
    const entry = journal.capture(snapshot('board', 'Mine'), 1);
    await repo.delete('board');
    await journal.recover(repo, copyName);
    expect(await repo.load('board')).toBeNull();
    expect((await repo.load(entry.recoveryId))?.name).toBe('Mine (recovered)');
    journal.capture(snapshot('other', 'One'), 1);
    new RecoveryJournal(storage, guest).capture(snapshot('other', 'Two'), 1);
    journal.discardBoard('other');
    expect(storage.length).toBe(0);
  });

  it('keeps guest/account snapshots and acknowledgements isolated, including the account outbox', async () => {
    const storage = new TestStorage();
    const account = new AccountBoardCache(randomUUID(), 'admin');
    const other = new AccountBoardCache(randomUUID(), 'basic');
    const id = randomUUID();
    try {
      await account.cacheRemote(snapshot(id, 'Cloud'), '7');
      const journal = new RecoveryJournal(storage, account.workspace);
      journal.capture(snapshot(id, 'Offline'), 1);
      expect(new RecoveryJournal(storage, guest).entries()).toEqual([]);
      expect(new RecoveryJournal(storage, other.workspace).entries()).toEqual([]);
      await expect(journal.recover(other, copyName)).rejects.toThrow('workspace does not match');
      await new RecoveryJournal(storage, account.workspace).recover(account, copyName);
      expect((await account.load(id))?.name).toBe('Offline');
      expect(await account.pending()).toHaveLength(1);
      expect(await other.list()).toEqual([]);
      expect(storage.length).toBe(0);
    } finally { await account.close(); await other.close(); }
  });

  it('reports quota/read/invalid/newer-schema errors and preserves unacknowledged data', async () => {
    const storage = new TestStorage();
    const journal = new RecoveryJournal(storage, guest);
    const entry = journal.capture(snapshot('board', 'Mine'), 1);
    const set = jest.spyOn(storage, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    expect(() => journal.capture(snapshot('board', 'Newer'), 1)).toThrow('Full');
    set.mockRestore();
    const raw = storage.getItem(entry.key)!;
    const unsupported = JSON.parse(raw);
    unsupported.record.schemaVersion = SCHEMA_VERSION + 1;
    storage.setItem(entry.key, JSON.stringify(unsupported));
    await expect(journal.recover(new MemoryBoardRepository(), copyName)).rejects.toThrow('Unsupported');
    expect(storage.length).toBe(1);
    storage.setItem(entry.key, '{broken');
    expect(() => journal.entries()).toThrow();
    expect(storage.getItem(entry.key)).toBe('{broken');
  });

  it('does not acknowledge memory-only recovery as durable', async () => {
    const storage = new TestStorage();
    const repo = new MemoryBoardRepository();
    await repo.save(snapshot('board', 'Old'), null);
    const journal = new RecoveryJournal(storage, guest);
    journal.capture(snapshot('board', 'Latest'), 1);
    await expect(journal.recover(repo, copyName)).rejects.toThrow('persistent board storage');
    await expect(journal.recover(repo, copyName)).rejects.toThrow('persistent board storage');
    expect(storage.length).toBe(1);
  });
});
