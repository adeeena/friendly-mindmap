import { BoardRepository } from './board-repository';

export class WorkspaceLockedError extends Error {
  constructor() { super('This account workspace is locked. Please log in again.'); }
}

/** Revokes application access to an account cache, including delayed read results. */
export function lockableRepository(repository: BoardRepository): { repository: BoardRepository; lock(): void } {
  let locked = false;
  const check = () => { if (locked) throw new WorkspaceLockedError(); };
  const guarded = <A extends unknown[], R>(operation: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    check();
    const result = await operation(...args);
    check();
    return result;
  };
  return {
    lock: () => { locked = true; },
    repository: {
      localDurability: repository.localDurability,
      workspace: repository.workspace, attachmentRole: repository.attachmentRole,
      list: guarded(repository.list.bind(repository)),
      load: guarded(repository.load.bind(repository)),
      save: guarded(repository.save.bind(repository)),
      delete: guarded(repository.delete.bind(repository)),
      putAttachment: guarded(repository.putAttachment.bind(repository)),
      ...(repository.copyAttachment ? { copyAttachment: guarded(repository.copyAttachment.bind(repository)) } : {}),
      getAttachment: guarded(repository.getAttachment.bind(repository)),
      deleteAttachment: guarded(repository.deleteAttachment.bind(repository)),
      listAttachmentIds: guarded(repository.listAttachmentIds.bind(repository)),
      ...(repository.collectUnreferencedAttachments
        ? { collectUnreferencedAttachments: guarded(repository.collectUnreferencedAttachments.bind(repository)) } : {}),
      getMeta: async <T>(key: string) => {
        check();
        const value = await repository.getMeta<T>(key);
        check();
        return value;
      },
      setMeta: guarded(repository.setMeta.bind(repository)),
    },
  };
}
