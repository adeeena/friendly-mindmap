import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { addRoot, node, openApp } from './helpers';

test('account tools float at the top-right with Log in at the far right', async ({ page }) => {
  await openApp(page);
  const account = page.locator('.bm-account-corner');
  const bounds = await account.boundingBox();
  const viewport = page.viewportSize()!;
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeLessThan(80);
  expect(bounds!.x + bounds!.width).toBeGreaterThan(viewport.width - 16);
  await expect(page.getByRole('toolbar').locator('bm-account-actions')).toHaveCount(0);
  const login = page.getByRole('button', { name: 'Log in', exact: true });
  await expect(login).toBeVisible();
  await expect(login.locator('bm-icon')).toHaveCount(0);
  const accountTools = page.locator('.bm-account-tools');
  const boards = accountTools.getByRole('button', { name: /^Open boards\./ });
  const exportButton = accountTools.getByRole('button', { name: 'Export' });
  const settingsButton = accountTools.getByRole('button', { name: 'Settings' });
  await expect(boards).toBeVisible();
  await expect(exportButton).toBeVisible();
  await expect(settingsButton).toBeVisible();
  await expect(page.getByRole('toolbar').getByRole('button', { name: 'Settings' })).toHaveCount(0);
  const loginBox = await login.boundingBox();
  const boardsBox = await boards.boundingBox();
  const exportBox = await exportButton.boundingBox();
  const settingsBox = await settingsButton.boundingBox();
  expect(loginBox).not.toBeNull();
  expect(boardsBox).not.toBeNull();
  expect(exportBox).not.toBeNull();
  expect(settingsBox).not.toBeNull();
  expect(boardsBox!.x + boardsBox!.width).toBeLessThanOrEqual(exportBox!.x + 1);
  expect(exportBox!.x + exportBox!.width).toBeLessThanOrEqual(settingsBox!.x + 1);
  expect(settingsBox!.x + settingsBox!.width).toBeLessThanOrEqual(loginBox!.x + 1);
});

test('optional login isolates guest work, restores account cache, and locks stale-cookie reloads after logout', async ({ page }) => {
  const account = {
    account: { id: randomUUID(), username: 'test', display_name: 'Test Admin', role: 'admin' },
    sessionId: randomUUID(), csrfToken: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z',
  };
  let signedIn = false;
  await page.route(/\/api\/boards\?includeDeleted=true$/, (route) => route.fulfill({ json: [] }));
  await page.route('**/api/auth/session', (route) => route.fulfill(signedIn
    ? { json: account } : { status: 401, json: { error: { code: 'AUTH_REQUIRED' } } }));
  await page.route('**/api/auth/login', async (route) => {
    signedIn = true;
    await route.fulfill({ json: account });
  });
  await page.route('**/api/auth/logout', (route) => route.fulfill({ status: 204 }));
  await openApp(page);
  await addRoot(page, 200, 200, 'Guest only');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Log in' });
  await expect(dialog.getByText('Sign in to save your work to the cloud.')).toBeVisible();
  await expect(dialog.getByText(/register|sign up/i)).toHaveCount(0);
  await dialog.getByLabel('Username', { exact: true }).fill('test');
  await dialog.getByLabel('Password', { exact: true }).fill('test-only-password');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await dialog.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Test Admin', { exact: true })).toBeVisible();
  await expect(node(page, 'Guest only')).toHaveCount(0);
  await expect(page.getByText('Cloud sync pending', { exact: true })).toBeVisible();
  await addRoot(page, 240, 240, 'Account only');
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(node(page, 'Guest only')).toBeVisible();
  await expect(node(page, 'Account only')).toHaveCount(0);
  await page.reload();
  await expect(node(page, 'Guest only')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log out', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await dialog.getByLabel('Username', { exact: true }).fill('test');
  await dialog.getByLabel('Password', { exact: true }).fill('test-only-password');
  await dialog.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(node(page, 'Account only')).toBeVisible();
  await expect(node(page, 'Guest only')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify(localStorage).includes('test-only-password'))).toBe(false);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('cloud-only files report availability, download once into the cache, and private print views lock after logout', async ({ page, context }) => {
  const accountId = randomUUID();
  const boardId = randomUUID();
  const account = {
    account: { id: accountId, username: 'test', display_name: 'Test Admin', role: 'admin' },
    sessionId: randomUUID(), csrfToken: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const cloudFile = { id: randomUUID(), name: 'cloud.txt', mime: 'text/plain', size: 11 };
  const lostFile = { id: randomUUID(), name: 'later.txt', mime: 'text/plain', size: 5 };
  const text = (value: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }] });
  const topic = (id: string, x: number, label: string, attachments: unknown[]) => ({
    id, parentId: null, kind: 'topic', x, y: 120, text: text(label), attachments,
  });
  const doc = {
    id: boardId, name: 'Cloud files',
    nodes: {
      one: topic('one', 80, 'Cloud node', [cloudFile]),
      two: topic('two', 320, 'Offline node', [lostFile]),
      list: { id: 'list', parentId: null, kind: 'checklist', x: 80, y: 260, text: text('Packing'),
        items: [{ id: 'item', text: 'Passport', checked: true }] },
    },
    children: { __root__: ['one', 'two', 'list'] }, links: {}, tags: {},
    settings: { snap: true, autoAlign: false, direction: 'horizontal', minimap: false },
  };
  const updatedAt = '2026-01-01T00:00:00.000Z';
  let signedIn = false;
  await context.route(/\/api\/boards\?includeDeleted=true$/, (route) => route.fulfill({
    json: [{ id: boardId, name: 'Cloud files', revision: '1', updatedAt, deletedAt: null }],
  }));
  await context.route(`**/api/boards/${boardId}`, (route) => route.fulfill({
    json: { id: boardId, name: 'Cloud files', revision: '1', updatedAt, deletedAt: null, schemaVersion: 2, doc, camera: { x: 0, y: 0, zoom: 1 } },
  }));
  await context.route(`**/api/boards/${boardId}/attachments/${cloudFile.id}`, (route) => route.fulfill({
    body: 'cloud bytes', headers: { 'content-length': '11', 'x-content-sha256': 'a'.repeat(64), 'content-type': 'application/octet-stream' },
  }));
  await context.route(`**/api/boards/${boardId}/attachments/${lostFile.id}`, (route) => route.abort('internetdisconnected'));
  await context.route('**/api/auth/session', (route) => route.fulfill(signedIn
    ? { json: account } : { status: 401, json: { error: { code: 'AUTH_REQUIRED' } } }));
  await context.route('**/api/auth/login', async (route) => { signedIn = true; await route.fulfill({ json: account }); });
  await context.route('**/api/auth/logout', async (route) => { signedIn = false; await route.fulfill({ status: 204 }); });
  await openApp(page);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Log in' });
  await dialog.getByLabel('Username', { exact: true }).fill('test');
  await dialog.getByLabel('Password', { exact: true }).fill('test-only-password');
  await dialog.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(node(page, 'Cloud node')).toBeVisible();

  await node(page, 'Cloud node').click();
  await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Notes and attachments' }).click();
  await expect(page.getByText('In the cloud, not downloaded to this device')).toBeVisible();
  expect((await new AxeBuilder({ page }).include('bm-notes-panel').analyze()).violations).toEqual([]);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download cloud.txt', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('cloud.txt');
  await expect(page.getByText('In the cloud, not downloaded to this device')).toHaveCount(0);

  await node(page, 'Offline node').click();
  await expect(page.getByText('In the cloud, not downloaded to this device')).toBeVisible();
  await page.getByRole('button', { name: 'Download later.txt', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'unavailable offline' })).toBeVisible();

  // A bundled export refuses to silently omit files whose bytes are not on this device.
  let downloaded = false;
  page.on('download', () => { downloaded = true; });
  await page.getByRole('button', { name: 'Close notes', exact: true }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: 'Export', exact: true });
  await exportDialog.getByLabel(/Embed attachments/).check();
  await exportDialog.getByRole('button', { name: 'Export file', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Export stopped' }).filter({ hasText: 'later.txt' })).toBeVisible();
  expect(downloaded).toBe(false);
  await page.keyboard.press('Escape');

  const print = await context.newPage();
  await print.addInitScript(() => { window.print = () => undefined; });
  await print.goto(`/print/${boardId}/list?w=${accountId}`);
  await expect(print.getByRole('heading', { name: 'Packing' })).toBeVisible();
  await expect(print.getByText('Passport')).toBeVisible();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(print.getByRole('alert')).toHaveText('This private checklist is locked. Log in to the same account in the app to print it.');
  await expect(print.getByText('Passport')).toHaveCount(0);
  const reopened = await context.newPage();
  await reopened.addInitScript(() => { window.print = () => undefined; });
  await reopened.goto(`/print/${boardId}/list?w=${accountId}`);
  await expect(reopened.getByRole('alert')).toHaveText(/locked/);
});

test('invalid login leaves guest content available and reports a generic error', async ({ page }) => {
  await page.route('**/api/auth/session', (route) => route.fulfill({ status: 401, json: {} }));
  await page.route('**/api/auth/login', (route) => route.fulfill({ status: 401, json: {} }));
  await openApp(page);
  await addRoot(page, 200, 200, 'Keep guest');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Log in' });
  await dialog.getByLabel('Username', { exact: true }).fill('test');
  await dialog.getByLabel('Password', { exact: true }).fill('invalid-test-password');
  await dialog.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.bm-toast').filter({ hasText: 'Invalid username or password.' })).toBeVisible();
  await expect(page.locator('.bm-banner').filter({ hasText: 'Invalid username or password.' })).toHaveCount(0);
  const toast = page.locator('.bm-toast').filter({ hasText: 'Invalid username or password.' });
  const bounds = await toast.boundingBox();
  const viewport = page.viewportSize()!;
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeLessThanOrEqual(viewport.width / 2);
  expect(Math.abs(bounds!.x + bounds!.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
  expect(bounds!.y + bounds!.height).toBeGreaterThan(viewport.height / 2);
  await expect(dialog.getByLabel('Password', { exact: true })).toHaveValue('');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(node(page, 'Keep guest')).toBeVisible();
});
