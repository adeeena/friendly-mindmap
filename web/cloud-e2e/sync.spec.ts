import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { APIRequestContext, Page, expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { BoardDoc } from '../../shared/model';
import { MOD, addRoot, node, openApp } from '../e2e/helpers';

interface FixtureState {
  boards: { id: string; name: string; revision: string; content: BoardDoc | null; deleted_at: string | null; is_staged: boolean; owner_username: string }[];
  history: { board_id: string; content_revision: string }[];
  files: { id: string; board_id: string; size_bytes: string; state: string; checksum: string }[];
  metrics: { lostCommits: number; lostParts: number; parts: Record<string, number>; heldLogouts: number; logoutCookies: number };
}
test.beforeEach(async ({ request }) => {
  // The login throttle and account preferences are shared per fixture user; each scenario starts clean.
  await request.post('/__test/control', { data: { resetLoginThrottle: true, resetConfigurations: true } });
});

async function state(request: APIRequestContext): Promise<FixtureState> {
  const response = await request.get('/__test/state');
  expect(response.ok()).toBe(true);
  return response.json();
}
async function pending(page: Page, account: string): Promise<number> {
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('better-mindmap-account-' + id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const request = db.transaction('outbox').objectStore('outbox').count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }, account);
}
async function rename(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Rename board', exact: true }).click();
  await page.getByRole('textbox', { name: 'Board name', exact: true }).fill(name);
  await page.getByRole('textbox', { name: 'Board name', exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: `Boards. Current board: ${name}`, exact: true })).toBeVisible();
}
async function boards(page: Page) {
  await page.getByRole('button', { name: /^Open boards\. Current board:/ }).click();
  return page.getByRole('dialog', { name: 'Boards', exact: true });
}
async function create(page: Page, name: string): Promise<void> {
  const dialog = await boards(page);
  await dialog.getByRole('textbox', { name: 'New board name' }).fill(name);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function loginAccount(target: Page, credentials: { username: string; password: string }, displayName = 'Sync Fixture'): Promise<string> {
  await target.getByRole('button', { name: 'Log in', exact: true }).click();
  const dialog = target.getByRole('dialog', { name: 'Log in' });
  await dialog.getByLabel('Username', { exact: true }).fill(credentials.username);
  await dialog.getByLabel('Password', { exact: true }).fill(credentials.password);
  await dialog.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(target.getByText(displayName, { exact: true })).toBeVisible();
  return (await (await target.request.get('/api/auth/session')).json()).account.id;
}

async function pendingRevocations(page: Page): Promise<number> {
  return page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('better-mindmap-revoke:')).length);
}

test('real cloud replay survives lost responses, cold offline CRUD, chunked files and two reconnecting tabs', async ({ page, context, request }) => {
  const credentials = await (await request.get('/__test/credentials')).json();
  await openApp(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await addRoot(page, 200, 200, 'Guest stays local');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  const login = page.getByRole('dialog', { name: 'Log in' });
  await login.getByLabel('Username', { exact: true }).fill(credentials.username);
  await login.getByLabel('Password', { exact: true }).fill(credentials.password);
  await login.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByText('Sync Fixture', { exact: true })).toBeVisible();
  const account = (await (await context.request.get('/api/auth/session')).json()).account.id as string;
  await expect.poll(async () => (await state(request)).boards.filter((board) => !board.is_staged).length).toBe(1);
  await expect.poll(() => pending(page, account)).toBe(0);
  const before = await state(request);
  const originalId = before.boards[0]!.id;
  await request.post('/__test/control', { data: { loseNextCommit: true } });
  await rename(page, 'Cloud original');
  await expect.poll(() => pending(page, account)).toBe(0);
  const acknowledged = await state(request);
  expect(acknowledged.metrics.lostCommits).toBe(1);
  expect(acknowledged.history.length).toBe(before.history.length + 1);
  expect(acknowledged.boards[0]!.name).toBe('Cloud original');

  await addRoot(page, 200, 200, 'Cloud files');
  await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Notes and attachments' }).click();
  await request.post('/__test/control', { data: { loseNextPart: true } });
  const bytes = Buffer.alloc(9 * 1024 * 1024 + 3, 37);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  await page.locator('bm-notes-panel input[type=file]').setInputFiles({
    name: 'large.bin', mimeType: 'application/octet-stream', buffer: bytes,
  });
  await expect(page.getByText('large.bin', { exact: true })).toBeVisible();
  await expect.poll(async () => (await state(request)).files.filter((file) => file.state === 'ready').length, { timeout: 30_000 }).toBe(1);
  await expect.poll(() => pending(page, account)).toBe(0);
  const uploaded = await state(request);
  expect(uploaded.metrics.lostParts).toBe(1);
  expect(Object.values(uploaded.metrics.parts)).toEqual([1, 1]);
  expect(uploaded.files[0]).toMatchObject({ size_bytes: String(bytes.length), checksum });
  const download = await context.request.get(`/api/boards/${originalId}/attachments/${uploaded.files[0]!.id}`);
  expect(download.ok()).toBe(true);
  expect(createHash('sha256').update(await download.body()).digest('hex')).toBe(checksum);
  await page.getByRole('button', { name: 'Close notes', exact: true }).click();

  await create(page, 'Delete offline');
  await expect.poll(() => pending(page, account)).toBe(0);
  let dialog = await boards(page);
  await dialog.locator('.bm-board-open').filter({ hasText: 'Cloud original' }).click();
  await expect(node(page, 'Cloud files')).toBeVisible();
  await context.setOffline(true);
  await rename(page, 'Offline renamed');
  dialog = await boards(page);
  await dialog.getByRole('button', { name: 'Duplicate Offline renamed', exact: true }).click();
  await expect(dialog.locator('.bm-board-title').filter({ hasText: /^Offline renamed copy$/ })).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete Delete offline', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Delete Delete offline', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await create(page, 'Cancelled offline');
  dialog = await boards(page);
  await dialog.getByRole('button', { name: 'Delete Cancelled offline', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Delete Cancelled offline', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await create(page, 'Created offline');
  await addRoot(page, 300, 240, 'Offline upload');
  await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Notes and attachments' }).click();
  await page.locator('bm-notes-panel input[type=file]').setInputFiles({
    name: 'offline.txt', mimeType: 'text/plain', buffer: Buffer.from('Offline bytes survive'),
  });
  await expect(page.getByText('offline.txt', { exact: true })).toBeVisible();
  await expect.poll(() => pending(page, account)).toBeGreaterThan(0);
  await page.close();
  const first = await context.newPage();
  await first.goto('/');
  await expect(node(first, 'Offline upload')).toBeVisible();
  const second = await context.newPage();
  await second.goto('/');
  await expect(node(second, 'Offline upload')).toBeVisible();
  await context.setOffline(false);
  await expect.poll(() => pending(first, account), { timeout: 30_000 }).toBe(0);
  await expect.poll(() => pending(second, account)).toBe(0);
  const synced = await state(request);
  expect(synced.boards.filter((board) => !board.deleted_at && !board.is_staged).map((board) => board.name).sort()).toEqual([
    'Created offline', 'Offline renamed', 'Offline renamed copy',
  ]);
  expect(synced.boards.find((board) => board.id === originalId)?.name).toBe('Offline renamed');
  expect(synced.boards.some((board) => board.name === 'Cancelled offline')).toBe(false);
  expect(synced.boards.filter((board) => board.deleted_at)).toHaveLength(1);
  expect(synced.files).toHaveLength(3);
  const copied = synced.boards.find((board) => board.name === 'Offline renamed copy')!;
  const copiedFile = synced.files.find((file) => file.board_id === copied.id)!;
  expect(copiedFile).toMatchObject({ state: 'ready', checksum, size_bytes: String(bytes.length) });
  expect(copiedFile.id).not.toBe(uploaded.files[0]!.id);
  expect(JSON.stringify(synced.boards)).not.toContain('Guest stays local');
  await first.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(node(first, 'Guest stays local')).toBeVisible();
});

test('independent devices preserve content, attachment bytes and tombstones through conflicts', async ({ page, context, browser, request }) => {
  const credentials = await (await request.get('/__test/credentials')).json();
  async function login(target: Page): Promise<string> {
    await openApp(target);
    return loginAccount(target, credentials);
  }
  const account = await login(page);
  await create(page, 'Conflict seed');
  await addRoot(page, 220, 200, 'Shared seed');
  await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Notes and attachments' }).click();
  const seedBytes = Buffer.from('Seed remote bytes');
  const seedChecksum = createHash('sha256').update(seedBytes).digest('hex');
  await page.locator('bm-notes-panel input[type=file]').setInputFiles({
    name: 'seed.txt', mimeType: 'text/plain', buffer: seedBytes,
  });

  await expect(page.getByText('seed.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close notes', exact: true }).click();
  await expect.poll(() => pending(page, account)).toBe(0);
  const originalId = (await state(request)).boards.find((board) => board.name === 'Conflict seed')!.id;
  const boardCount = (await state(request)).boards.length;
  const otherContext = await browser.newContext({ baseURL: 'http://127.0.0.1:4312' });
  try {
    const other = await otherContext.newPage();
    await login(other);
    await expect(node(other, 'Shared seed')).toBeVisible();
    expect((await state(request)).boards).toHaveLength(boardCount);
    await context.setOffline(true);
    await addRoot(page, 380, 300, 'Device A work');
    await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Notes and attachments' }).click();
    const bytes = Buffer.from('Recovered file bytes');
    const checksum = createHash('sha256').update(bytes).digest('hex');
    await page.locator('bm-notes-panel input[type=file]').setInputFiles({
      name: 'recover.txt', mimeType: 'text/plain', buffer: bytes,
    });
    await expect(page.getByText('recover.txt', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close notes', exact: true }).click();
    await addRoot(other, 400, 200, 'Device B wins');
    await expect.poll(() => pending(other, account)).toBe(0);
    await context.setOffline(false);
    await expect.poll(() => pending(page, account), { timeout: 30_000 }).toBe(0);
    await expect(page.getByRole('alert').filter({ hasText: 'Your local version and attachment references are preserved' })).toBeVisible();
    expect((await new AxeBuilder({ page }).include('.bm-banners').analyze()).violations).toEqual([]);
    let remote = await state(request);
    const original = remote.boards.find((board) => board.id === originalId)!;
    expect(JSON.stringify(original.content)).toContain('Device B wins');
    expect(JSON.stringify(original.content)).not.toContain('Device A work');
    const copy = remote.boards.find((board) => board.id !== originalId && JSON.stringify(board.content).includes('Device A work'))!;
    expect(copy).toBeDefined();
    const attachment = remote.files.find((file) => file.board_id === copy.id && file.checksum === checksum)!;
    expect(attachment).toMatchObject({ checksum, size_bytes: String(bytes.length), state: 'ready' });
    const recovered = await context.request.get(`/api/boards/${copy.id}/attachments/${attachment.id}`);
    expect(await recovered.body()).toEqual(bytes);

    await otherContext.setOffline(true);
    await addRoot(other, 470, 340, 'Device B uncached recovery');
    await addRoot(page, 440, 250, 'Device A wins next');
    await expect.poll(() => pending(page, account)).toBe(0);
    await otherContext.setOffline(false);
    await expect.poll(() => pending(other, account), { timeout: 30_000 }).toBe(0);
    remote = await state(request);
    const uncachedCopy = remote.boards.find((board) => JSON.stringify(board.content).includes('Device B uncached recovery'))!;
    expect(uncachedCopy.id).not.toBe(originalId);
    const downloadedCopy = remote.files.find((file) => file.board_id === uncachedCopy.id && file.checksum === seedChecksum)!;
    expect(downloadedCopy.state).toBe('ready');
    const seedDownload = await otherContext.request.get(`/api/boards/${uncachedCopy.id}/attachments/${downloadedCopy.id}`);
    expect(await seedDownload.body()).toEqual(seedBytes);

    await context.setOffline(true);
    await addRoot(page, 450, 320, 'Edits after remote deletion');
    await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Notes and attachments' }).click();
    await page.locator('bm-notes-panel input[type=file]').setInputFiles({
      name: 'after-delete.txt', mimeType: 'text/plain', buffer: Buffer.from('Also survives deletion'),
    });
    await expect(page.getByText('after-delete.txt', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close notes', exact: true }).click();
    let dialog = await boards(other);
    await dialog.getByRole('button', { name: 'Delete Conflict seed', exact: true }).click();
    await other.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect.poll(() => pending(other, account)).toBe(0);
    await context.setOffline(false);
    await expect.poll(() => pending(page, account), { timeout: 30_000 }).toBe(0);
    remote = await state(request);
    expect(remote.boards.find((board) => board.id === originalId)?.deleted_at).not.toBeNull();
    const deletionCopy = remote.boards.find((board) => JSON.stringify(board.content).includes('Edits after remote deletion'))!;
    expect(deletionCopy.id).not.toBe(originalId);
    expect(remote.files.find((file) => file.board_id === deletionCopy.id)?.state).toBe('ready');

    await create(page, 'Delete conflict seed');
    await addRoot(page, 200, 200, 'Old content before delete');
    await expect.poll(() => pending(page, account)).toBe(0);
    const deleteId = (await state(request)).boards.find((board) => board.name === 'Delete conflict seed')!.id;
    await other.evaluate(() => window.dispatchEvent(new Event('focus')));
    dialog = await boards(other);
    await expect(dialog.locator('.bm-board-title').filter({ hasText: /^Delete conflict seed$/ })).toBeVisible();
    await dialog.locator('.bm-board-open').filter({ hasText: 'Delete conflict seed' }).click();
    await context.setOffline(true);
    dialog = await boards(page);
    await dialog.getByRole('button', { name: 'Delete Delete conflict seed', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await addRoot(other, 430, 250, 'New remote work must survive');
    await expect.poll(() => pending(other, account)).toBe(0);
    await context.setOffline(false);
    await expect.poll(() => pending(page, account), { timeout: 30_000 }).toBe(0);
    remote = await state(request);
    const kept = remote.boards.find((board) => board.id === deleteId)!;
    expect(kept.deleted_at).toBeNull();
    expect(JSON.stringify(kept.content)).toContain('New remote work must survive');
    expect(remote.boards.some((board) => board.id !== deleteId && JSON.stringify(board.content).includes('Old content before delete')
      && !JSON.stringify(board.content).includes('New remote work must survive'))).toBe(true);
    await expect(page.getByRole('alert').filter({ hasText: 'It was not deleted; your previous local version is preserved' })).toBeVisible();
  } finally { await otherContext.close(); }
});

test('offline logout locks live tabs, survives reload, and revokes only the captured session after reconnect', async ({ page, context, request }) => {
  const credentials = await (await request.get('/__test/credentials')).json();
  await openApp(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await addRoot(page, 200, 200, 'Guest after account lock');
  const account = await loginAccount(page, credentials);
  await create(page, 'Session recovery');
  await addRoot(page, 240, 240, 'Before logout');
  await expect.poll(() => pending(page, account), { timeout: 30_000 }).toBe(0);
  const other = await context.newPage();
  await openApp(other);
  await expect(node(other, 'Before logout')).toBeVisible();
  await context.setOffline(true);
  await addRoot(page, 420, 300, 'Queued before offline logout');
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(node(page, 'Guest after account lock')).toBeVisible();
  await expect(node(other, 'Guest after account lock')).toBeVisible();
  await expect(node(other, 'Before logout')).toHaveCount(0);
  expect(await pendingRevocations(page)).toBe(1);
  await page.reload();
  await expect(node(page, 'Guest after account lock')).toBeVisible();
  expect(await pendingRevocations(page)).toBe(1);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => pendingRevocations(page), { timeout: 30_000 }).toBe(0);
  expect((await context.request.get('/api/auth/session')).status()).toBe(401);
  await loginAccount(page, credentials);
  await expect(node(page, 'Queued before offline logout')).toBeVisible();
  await expect.poll(() => pending(page, account), { timeout: 30_000 }).toBe(0);

  const captured = (await (await context.request.get('/api/auth/session')).json()).sessionId as string;
  await page.evaluate(({ accountId, sessionId }) => {
    localStorage.setItem('better-mindmap-revoke:' + sessionId, JSON.stringify({ accountId, sessionId }));
  }, { accountId: account, sessionId: captured });
  await request.post('/__test/control', { data: { holdNextLogout: true } });
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(async () => (await state(request)).metrics.heldLogouts).toBe(1);
    expect((await state(request)).metrics.logoutCookies).toBe(0);
    const newer = await context.request.post('/api/auth/login', {
      headers: { Origin: 'http://127.0.0.1:4312' }, data: credentials,
    });
    expect(newer.ok()).toBe(true);
    const newerId = (await newer.json()).sessionId;
    await request.post('/__test/control', { data: { releaseLogout: true } });
    await expect.poll(() => pendingRevocations(page)).toBe(0);
    expect((await (await context.request.get('/api/auth/session')).json()).sessionId).toBe(newerId);
  } finally { await request.post('/__test/control', { data: { releaseLogout: true } }); }
});

test('a session that expires offline locks cached work until matching-account login restores and synchronizes it', async ({ page, context, request }) => {
  const credentials = await (await request.get('/__test/credentials')).json();
  await openApp(page);
  const account = await loginAccount(page, credentials);
  await create(page, 'Expired session recovery');
  await addRoot(page, 200, 200, 'Before expiration');
  await expect.poll(() => pending(page, account), { timeout: 30_000 }).toBe(0);
  await context.setOffline(true);
  await addRoot(page, 420, 300, 'Preserved after expiration');
  await request.post('/__test/control', { data: { expireSessions: true } });
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Sync Fixture', { exact: true })).toHaveCount(0);
  await expect(node(page, 'Preserved after expiration')).toHaveCount(0);
  await expect(page.getByRole('alert').filter({ hasText: 'Log in again to reopen your preserved work.' })).toBeVisible();
  expect(await pending(page, account)).toBeGreaterThan(0);
  await loginAccount(page, credentials);
  await expect(node(page, 'Preserved after expiration')).toBeVisible();
  await expect.poll(() => pending(page, account), { timeout: 30_000 }).toBe(0);
});

test('documented sequence: guest work, login, offline edits and reload, reconnect sync, logout back to the guest workspace', async ({ page, context, request }) => {
  const credentials = await (await request.get('/__test/credentials')).json();
  await openApp(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await addRoot(page, 200, 200, 'Guest only work');
  const account = await loginAccount(page, credentials);
  await expect(node(page, 'Guest only work')).toHaveCount(0);
  await addRoot(page, 220, 220, 'Cloud online work');
  await expect.poll(() => pending(page, account), { timeout: 30_000 }).toBe(0);

  await context.setOffline(true);
  await addRoot(page, 360, 300, 'Cloud offline work');
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto('/');
  await expect(node(reopened, 'Cloud offline work')).toBeVisible();
  await expect(reopened.getByText('Offline account cache. Log in to verify your account before cloud synchronization.')).toBeVisible();
  await context.setOffline(false);
  await expect.poll(() => pending(reopened, account), { timeout: 40_000 }).toBe(0);
  const synced = await state(request);
  expect(synced.boards.some((board) => JSON.stringify(board.content).includes('Cloud offline work'))).toBe(true);
  expect(synced.boards.some((board) => JSON.stringify(board.content).includes('Guest only work'))).toBe(false);

  await reopened.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(node(reopened, 'Guest only work')).toBeVisible();
  await expect(node(reopened, 'Cloud offline work')).toHaveCount(0);
  await expect(reopened.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
});

test('explicit cache discard warns about unsynchronized work, removes only the device copy and leaves cloud data untouched', async ({ page, context, request }) => {
  const credentials = await (await request.get('/__test/credentials')).json();
  await openApp(page);
  const account = await loginAccount(page, credentials);
  await create(page, 'Discard me');
  await addRoot(page, 200, 200, 'Synced node');
  await expect.poll(() => pending(page, account), { timeout: 30_000 }).toBe(0);
  await context.setOffline(true);
  await addRoot(page, 360, 300, 'Unsynced node');
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: /Settings/ });
  await settings.getByRole('tab', { name: 'Cloud data on this device' }).click();
  await expect(settings.getByText('Sync Fixture')).toBeVisible();
  await expect(settings.getByText(/\d+ changes not yet synchronized/)).toBeVisible();
  await settings.getByRole('button', { name: 'Discard from this device' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('not synchronized yet');
  await expect(confirm).toContainText('cannot be recovered');
  await confirm.getByRole('button', { name: 'Discard from this device' }).click();
  await expect(page.locator('.bm-toast').filter({ hasText: 'Removed the cached data' })).toBeVisible();
  await expect(settings.getByRole('tab', { name: 'Cloud data on this device' })).toHaveCount(0);
  const databases = await page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name));
  expect(databases).not.toContain(`better-mindmap-account-${account}`);

  await context.setOffline(false);
  const remote = await state(request);
  const board = remote.boards.find((item) => item.name === 'Discard me')!;
  expect(JSON.stringify(board.content)).toContain('Synced node');
  expect(JSON.stringify(board.content)).not.toContain('Unsynced node');
  await page.keyboard.press('Escape');
  await loginAccount(page, credentials);
  const dialog = await boards(page);
  await dialog.locator('.bm-board-open').filter({ hasText: 'Discard me' }).click();
  await expect(node(page, 'Synced node')).toBeVisible();
  await expect(node(page, 'Unsynced node')).toHaveCount(0);
});

test('board history lists retained revisions, restores one as a new revision with its file bytes, and needs a connection', async ({ page, context, request }) => {
  const credentials = await (await request.get('/__test/credentials')).json();
  await openApp(page);
  await loginAccount(page, credentials);
  await create(page, 'History board');
  const saved = async () => {
    await page.keyboard.press(`${MOD}+s`);
    await expect(page.locator('.bm-toast').filter({ hasText: 'Saved to cloud.' }).last()).toBeVisible();
  };
  await addRoot(page, 220, 200, 'Rev one');
  await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Notes and attachments' }).click();
  const fileBytes = Buffer.from('historical bytes');
  await page.locator('bm-notes-panel input[type=file]').setInputFiles({ name: 'hist.txt', mimeType: 'text/plain', buffer: fileBytes });
  await expect(page.getByText('hist.txt', { exact: true })).toBeVisible();
  await saved();
  await page.getByRole('button', { name: 'Remove hist.txt', exact: true }).click();
  await page.getByRole('button', { name: 'Close notes', exact: true }).click();
  await saved();
  await addRoot(page, 420, 320, 'Rev three');
  await saved();

  const boardId = (await state(request)).boards.find((board) => board.name === 'History board')!.id;

  await (await boards(page)).getByRole('button', { name: 'Board history' }).click();
  const history = page.getByRole('dialog', { name: 'Board history' });
  const inspects = history.getByRole('button', { name: /^Inspect revision/ });
  await expect(inspects.first()).toBeVisible();
  const revisionsBefore = await inspects.count();
  expect(revisionsBefore).toBeGreaterThanOrEqual(3);
  expect((await state(request)).history.filter((row) => row.board_id === boardId)).toHaveLength(revisionsBefore);
  await expect(history.locator('.bm-history-item.current')).toHaveCount(1);
  await expect(history.locator('.bm-history-item.current').getByRole('button', { name: /^Restore revision/ })).toBeDisabled();
  let withFile = -1;
  for (let index = 0; index < revisionsBefore; index++) {
    await inspects.nth(index).click();
    const revision = /revision (\d+)/.exec((await inspects.nth(index).getAttribute('aria-label'))!)![1];
    await expect(history.getByRole('heading', { name: `Revision ${revision}`, level: 3 })).toBeVisible();
    if (await history.locator('.bm-history-file').getByText('hist.txt').count()) withFile = index;
  }
  expect(withFile).toBeGreaterThanOrEqual(0);
  await inspects.nth(withFile).click();
  await expect(history.locator('.bm-history-file').getByText('hist.txt')).toBeVisible();
  await history.locator('.bm-history-item').nth(withFile).getByRole('button', { name: /^Restore revision/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.locator('.bm-toast').filter({ hasText: 'as a new revision' })).toBeVisible();
  await expect(history).toHaveCount(0);

  await expect.poll(async () => (await state(request)).history.filter((row) => row.board_id === boardId).length).toBe(revisionsBefore + 1);
  await expect(node(page, 'Rev three')).toHaveCount(0, { timeout: 30_000 });
  await node(page, 'Rev one').click();
  await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Notes and attachments' }).click();
  await expect(page.getByText('hist.txt', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download hist.txt', exact: true }).click();
  expect(readFileSync(await (await download).path())).toEqual(fileBytes);
  await page.getByRole('button', { name: 'Close notes', exact: true }).click();

  await context.setOffline(true);
  await (await boards(page)).getByRole('button', { name: 'Board history' }).click();
  await expect(page.getByRole('dialog', { name: 'Board history' }).getByRole('alert')).toContainText('needs a connection');
  await page.keyboard.press('Escape');
});

test('Ctrl/Cmd+S reports cloud success only after acknowledgement, never claims it offline or after expiry, and offline imports sync', async ({ page, context, request }) => {
  const credentials = await (await request.get('/__test/credentials')).json();
  await openApp(page);
  const account = await loginAccount(page, credentials);
  await create(page, 'Save loop');
  await addRoot(page, 200, 200, 'First saved');
  let downloaded = false;
  page.on('download', () => { downloaded = true; });
  await page.keyboard.press(`${MOD}+s`);
  await expect(page.getByRole('status').filter({ hasText: 'Saved to cloud.' })).toBeVisible();
  expect(downloaded).toBe(false);
  const saved = (await state(request)).boards.find((board) => board.name === 'Save loop')!;
  expect(JSON.stringify(saved.content)).toContain('First saved');
  expect(await pending(page, account)).toBe(0);
  await expect(page.getByText('Sign in to save your work to the cloud.')).toHaveCount(0);

  await context.setOffline(true);
  await addRoot(page, 360, 300, 'Typed offline');
  await page.keyboard.press(`${MOD}+s`);
  await expect(page.getByRole('status').filter({ hasText: 'Cloud sync is pending' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Saved to cloud.' })).toHaveCount(0);
  expect(await pending(page, account)).toBeGreaterThan(0);

  const imported = {
    format: 'better-mindmap', schemaVersion: 2,
    board: { doc: {
      id: randomUUID(), name: 'Imported offline',
      nodes: { one: { id: 'one', parentId: null, kind: 'topic', x: 100, y: 100,
        text: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Imported offline node' }] }] } } },
      children: { __root__: ['one'] }, links: {}, tags: {},
      settings: { snap: true, autoAlign: false, direction: 'horizontal', minimap: false },
    }, camera: { x: 0, y: 0, zoom: 1 } },
    attachments: [],
  };
  let dialog = await boards(page);
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Import from file' }).click();
  await (await chooser).setFiles({ name: 'offline.bmm.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
  await expect(node(page, 'Imported offline node')).toBeVisible();

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => pending(page, account), { timeout: 30_000 }).toBe(0);
  const synced = await state(request);
  expect(JSON.stringify(synced.boards.find((board) => board.name === 'Save loop')!.content)).toContain('Typed offline');
  expect(synced.boards.some((board) => board.name === 'Imported offline' && !board.deleted_at)).toBe(true);

  await context.setOffline(true);
  await addRoot(page, 520, 360, 'After expiry');
  await request.post('/__test/control', { data: { expireSessions: true } });
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => fetch('/api/auth/session').then((r) => r.status, () => 0))).toBe(401);
  await page.keyboard.press(`${MOD}+s`);
  // The expired session locks the account first, so the save is local-only and never claims cloud success.
  await expect(page.locator('.bm-toast').filter({ hasText: 'Saved on this device' }).last()).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Log in again to reopen your preserved work.' })).toBeVisible();
  await expect(page.locator('.bm-toast').filter({ hasText: 'Saved to cloud.' })).toHaveCount(0);
});

test('account appearance and language sync across devices without erasing each other or guest preferences', async ({ page, context, browser, request }) => {
  const credentials = await (await request.get('/__test/credentials')).json();
  const configuration = async () => (await (await context.request.get('/api/account/configuration')).json()).configuration;
  await openApp(page);
  const guestBefore = await page.evaluate(() => localStorage.getItem('friendly-mindmap.settings'));
  await loginAccount(page, credentials);
  const otherContext = await browser.newContext({ baseURL: 'http://127.0.0.1:4312' });
  try {
    const other = await otherContext.newPage();
    await openApp(other);
    await loginAccount(other, credentials);
    await otherContext.setOffline(true);
    await other.getByRole('button', { name: 'Settings', exact: true }).click();
    await other.getByRole('tab', { name: 'Language' }).click();
    await other.getByRole('radio', { name: 'Français' }).check();
    await expect(other.locator('html')).toHaveAttribute('lang', 'fr');
    await other.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Theme', { exact: true }).selectOption('win98');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'win98');
    await page.keyboard.press('Escape');
    await expect.poll(configuration).toEqual({ theme: 'win98' });

    await otherContext.setOffline(false);
    await other.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(configuration, { timeout: 30_000 }).toEqual({ theme: 'win98', language: 'fr' });
    await expect(other.locator('html')).toHaveAttribute('data-theme', 'win98');
    await expect(other.locator('html')).toHaveAttribute('lang', 'fr');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');

    expect(await page.evaluate(() => localStorage.getItem('friendly-mindmap.settings'))).toBe(guestBefore);
    await page.getByRole('button', { name: /Se déconnecter|Log out/ }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', guestBefore ? 'fr' : 'en');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'win98');
    expect(await page.evaluate(() => localStorage.getItem('friendly-mindmap.settings'))).toBe(guestBefore);
  } finally { await otherContext.close(); }
});

test('an interrupted device write reports failure on Ctrl/Cmd+S, never claims a cloud save, and recovers without losing the edit', async ({ page, request }) => {
  const credentials = await (await request.get('/__test/credentials')).json();
  await openApp(page);
  const account = await loginAccount(page, credentials);
  await create(page, 'Storage interruption');
  await addRoot(page, 200, 200, 'Stored before');
  await expect.poll(() => pending(page, account), { timeout: 30_000 }).toBe(0);

  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    (window as unknown as { __restorePut: () => void }).__restorePut = () => { IDBObjectStore.prototype.put = original; };
    IDBObjectStore.prototype.put = function () { throw new DOMException('Device storage is full', 'QuotaExceededError'); };
  });
  await addRoot(page, 380, 300, 'Blocked by full storage');
  await page.keyboard.press('ControlOrMeta+s');
  const toast = page.locator('.bm-toast');
  await expect(toast.filter({ hasText: 'Could not save on this device' })).toBeVisible();
  await expect(toast.filter({ hasText: 'Saved to cloud' })).toHaveCount(0);
  expect(JSON.stringify((await state(request)).boards.map((board) => board.content))).not.toContain('Blocked by full storage');

  await page.evaluate(() => (window as unknown as { __restorePut: () => void }).__restorePut());
  await expect(node(page, 'Blocked by full storage')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(toast.filter({ hasText: 'Saved to cloud' })).toBeVisible();
  expect(JSON.stringify((await state(request)).boards.map((board) => board.content))).toContain('Blocked by full storage');
});

test('switching accounts keeps each account\u2019s boards and unsynchronized work isolated, and never replays one account under another session', async ({ page, context, request }) => {
  const first = await (await request.get('/__test/credentials')).json();
  const second = await (await request.get('/__test/credentials?who=second')).json();
  await openApp(page);
  const firstAccount = await loginAccount(page, first);
  await create(page, 'Account A board');
  await addRoot(page, 200, 200, 'A synced');
  await expect.poll(() => pending(page, firstAccount), { timeout: 30_000 }).toBe(0);
  await context.setOffline(true);
  await addRoot(page, 380, 300, 'A unsynced');
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  await context.setOffline(false);

  const secondAccount = await loginAccount(page, second, 'Second Fixture');
  expect(secondAccount).not.toBe(firstAccount);
  await expect(node(page, 'A synced')).toHaveCount(0);
  await expect(node(page, 'A unsynced')).toHaveCount(0);
  let dialog = await boards(page);
  await expect(dialog.locator('.bm-board-open').filter({ hasText: 'Account A board' })).toHaveCount(0);
  await dialog.getByRole('textbox', { name: 'New board name' }).fill('Account B board');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await addRoot(page, 220, 220, 'B work');
  await expect.poll(() => pending(page, secondAccount), { timeout: 30_000 }).toBe(0);

  const during = await state(request);
  const ownedBy = (owner: string) => JSON.stringify(during.boards.filter((board) => board.owner_username === owner).map((board) => board.content));
  expect(ownedBy('second-fixture')).toContain('B work');
  expect(ownedBy('second-fixture')).not.toContain('A synced');
  expect(ownedBy('sync-fixture')).toContain('A synced');
  expect(ownedBy('sync-fixture')).not.toContain('A unsynced');
  expect(ownedBy('sync-fixture')).not.toContain('B work');
  expect(await pending(page, firstAccount)).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  await expect(node(page, 'B work')).toHaveCount(0);
  await loginAccount(page, first);
  await expect(node(page, 'A unsynced')).toBeVisible();
  await expect(node(page, 'B work')).toHaveCount(0);
  await expect.poll(() => pending(page, firstAccount), { timeout: 30_000 }).toBe(0);
  dialog = await boards(page);
  await expect(dialog.locator('.bm-board-open').filter({ hasText: 'Account B board' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  const after = await state(request);
  const afterOwned = (owner: string) => JSON.stringify(after.boards.filter((board) => board.owner_username === owner).map((board) => board.content));
  expect(afterOwned('sync-fixture')).toContain('A unsynced');
  expect(afterOwned('sync-fixture')).not.toContain('B work');
  expect(afterOwned('second-fixture')).toContain('B work');
  expect(afterOwned('second-fixture')).not.toContain('A unsynced');
});