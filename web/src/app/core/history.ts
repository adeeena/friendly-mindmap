import { Patch, applyPatches, enablePatches, produceWithPatches, Draft } from 'immer';

enablePatches();

export interface HistoryEntry {
  patches: Patch[];
  inverse: Patch[];
  txn?: string;
  label?: string;
}

export const HISTORY_LIMIT = 200;

/** Patch-based undo/redo for an immutable state value. */
export class History<T> {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(private readonly limit = HISTORY_LIMIT) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Applies a recipe and records it; entries with the same txn as the last one merge. */
  apply<R>(
    state: T,
    recipe: (draft: Draft<T>) => R,
    opts: { txn?: string; label?: string; record?: boolean } = {},
  ): { state: T; result: R; changed: boolean } {
    let result!: R;
    const [next, patches, inverse] = produceWithPatches(state, (d: Draft<T>) => {
      result = recipe(d);
    });
    if (!patches.length) return { state, result, changed: false };
    if (opts.record !== false) this.record({ patches, inverse, txn: opts.txn, label: opts.label });
    return { state: next as T, result, changed: true };
  }

  private record(entry: HistoryEntry): void {
    const last = this.undoStack[this.undoStack.length - 1];
    if (entry.txn && last && last.txn === entry.txn) {
      last.patches = [...last.patches, ...entry.patches];
      last.inverse = [...entry.inverse, ...last.inverse];
    } else {
      this.undoStack.push(entry);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.redoStack = [];
  }

  /** Ends any open transaction so the next edit starts a new step. */
  seal(): void {
    const last = this.undoStack[this.undoStack.length - 1];
    if (last) last.txn = undefined;
  }

  undo(state: T): T | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push({ ...entry, txn: undefined });
    return applyPatches(state as object, entry.inverse) as T;
  }

  redo(state: T): T | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    return applyPatches(state as object, entry.patches) as T;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
