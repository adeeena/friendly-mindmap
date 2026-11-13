import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SwUpdate, VersionEvent, UnrecoverableStateEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { AppUpdates } from './app-updates';
import { BoardSession, SaveStatus } from './persistence/board-session';

describe('application update durability', () => {
  it('offers an update without activating it and flushes before allowing a reload', async () => {
    const events = new Subject<VersionEvent>();
    const failures = new Subject<UnrecoverableStateEvent>();
    const activate = jest.fn();
    const flush = jest.fn().mockResolvedValue(undefined);
    const status = signal<SaveStatus>('saved');
    TestBed.configureTestingModule({ providers: [
      { provide: SwUpdate, useValue: { isEnabled: true, versionUpdates: events, unrecoverable: failures, activateUpdate: activate } },
      { provide: BoardSession, useValue: { flush, status, repository: { localDurability: 'persistent' } } },
    ] });
    const updates = TestBed.inject(AppUpdates);
    events.next({ type: 'VERSION_READY', currentVersion: { hash: 'one' }, latestVersion: { hash: 'two' } });
    expect(updates.available()).toBe(true);
    expect(activate).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
    expect(await updates.prepareReload()).toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
    status.set('error');
    expect(await updates.prepareReload()).toBe(false);
    failures.next({ type: 'UNRECOVERABLE_STATE', reason: 'Missing application asset' });
    expect(updates.failed()).toBe(true);
  });
});
