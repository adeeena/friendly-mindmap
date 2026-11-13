import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { APIRequestContext, Page, expect, test } from '@playwright/test';
import { MOD, addRoot, node } from '../e2e/helpers';

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be provided by the acceptance driver`);
  return value;
};
const phase = process.env['STACK_PHASE'] ?? 'loop';
const stateFile = env('STACK_STATE_FILE');

async function login(page: Page, username: string, password: string): Promise<{ id: string; role: string }> {
  await page.goto('/');
  await expect(page.locator('.bm-save-status')).toBeAttached();
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Log in' });
  await expect(dialog.getByText('Sign in to save your work to the cloud.')).toBeVisible();
  await dialog.getByLabel('Username', { exact: true }).fill(username);
  await dialog.getByLabel('Password', { exact: true }).fill(password);
  await dialog.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible({ timeout: 60_000 });
  const session = await (await page.request.get('/api/auth/session')).json();
  return { id: session.account.id, role: session.account.role };
}

async function boards(page: Page) {
  await page.getByRole('button', { name: /^Open boards\. Current board:/ }).click();
  return page.getByRole('dialog', { name: 'Boards', exact: true });
}

async function createBoard(page: Page, name: string): Promise<void> {
  const dialog = await boards(page);
  await dialog.getByRole('textbox', { name: 'New board name' }).fill(name);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function save(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+s`);
  await expect(page.locator('.bm-toast').filter({ hasText: 'Saved to cloud.' }).last()).toBeVisible({ timeout: 180_000 });
}

async function openNotes(page: Page): Promise<void> {
  await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Notes and attachments' }).click();
}

async function listBoards(request: APIRequestContext): Promise<{ id: string; name: string }[]> {
  return (await request.get('/api/boards')).json();
}

async function historyCount(request: APIRequestContext, boardId: string): Promise<number> {
  return (await (await request.get(`/api/boards/${boardId}/history?limit=50`)).json()).items.length;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

test.describe.configure({ mode: 'serial' });

if (phase === 'loop') {
  test('admin full loop: login, edit, Ctrl+S, reload, second device, multiple and large files, history restore, logout', async ({ page, browser }) => {
    const account = await login(page, env('STACK_ADMIN_USER'), env('STACK_ADMIN_PASSWORD'));
    expect(account.role).toBe('admin');
    await createBoard(page, 'Admin loop');
    await addRoot(page, 220, 200, 'Admin first');
    await save(page);
    await page.reload();
    await expect(node(page, 'Admin first')).toBeVisible();

    // Second device sees the saved cloud board.
    const secondContext = await browser.newContext({ baseURL: env('STACK_URL') });
    try {
      const second = await secondContext.newPage();
      await login(second, env('STACK_ADMIN_USER'), env('STACK_ADMIN_PASSWORD'));
      const list = await boards(second);
      await list.locator('.bm-board-open').filter({ hasText: 'Admin loop' }).click();
      await expect(node(second, 'Admin first')).toBeVisible();
    } finally { await secondContext.close(); }

    // Several files on one node, two of them above the basic 5 MiB limit.
    await node(page, 'Admin first').click();
    await openNotes(page);
    const files = [
      { name: 'small.txt', buffer: Buffer.from('small admin file') },
      { name: 'large-six.bin', buffer: Buffer.alloc(6 * 1024 * 1024 + 7, 11) },
      { name: 'large-nine.bin', buffer: Buffer.alloc(9 * 1024 * 1024 + 13, 29) },
    ].map((file) => ({ ...file, mimeType: 'application/octet-stream' }));
    await page.locator('bm-notes-panel input[type=file]').setInputFiles(files);
    for (const file of files) await expect(page.getByText(file.name, { exact: true })).toBeVisible();
    await save(page);
    const board = (await listBoards(page.request)).find((item) => item.name === 'Admin loop')!;
    const detail = await (await page.request.get(`/api/boards/${board.id}`)).json();
    const attachments = Object.values(detail.doc.nodes as Record<string, { attachments?: { id: string; name: string; size: number }[] }>)
      .flatMap((entry) => entry.attachments ?? []);
    expect(attachments.map((file) => file.name).sort()).toEqual(files.map((file) => file.name).sort());
    const checksums: Record<string, string> = {};
    for (const file of files) {
      const meta = attachments.find((entry) => entry.name === file.name)!;
      const download = await page.request.get(`/api/boards/${board.id}/attachments/${meta.id}`);
      expect(download.ok()).toBe(true);
      expect(sha256(await download.body())).toBe(sha256(file.buffer));
      checksums[meta.id] = sha256(file.buffer);
    }

    // History: drop the files, add a node, then restore the revision that still has them.
    for (const file of files) await page.getByRole('button', { name: `Remove ${file.name}`, exact: true }).click();
    await page.getByRole('button', { name: 'Close notes', exact: true }).click();
    await save(page);
    await addRoot(page, 420, 320, 'Admin later');
    await save(page);
    await (await boards(page)).getByRole('button', { name: 'Board history' }).click();
    const history = page.getByRole('dialog', { name: 'Board history' });
    const inspects = history.getByRole('button', { name: /^Inspect revision/ });
    await expect(inspects.first()).toBeVisible();
    let target = -1;
    for (let index = 0; index < await inspects.count(); index++) {
      await inspects.nth(index).click();
      const revision = /revision (\d+)/.exec((await inspects.nth(index).getAttribute('aria-label'))!)![1];
      await expect(history.getByRole('heading', { name: `Revision ${revision}`, level: 3 })).toBeVisible();
      if (await history.locator('.bm-history-file').getByText('large-nine.bin').count()) target = index;
    }
    expect(target).toBeGreaterThanOrEqual(0);
    await history.locator('.bm-history-item').nth(target).getByRole('button', { name: /^Restore revision/ }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(page.locator('.bm-toast').filter({ hasText: 'as a new revision' })).toBeVisible();
    await expect(node(page, 'Admin later')).toHaveCount(0, { timeout: 60_000 });
    for (const [id, checksum] of Object.entries(checksums)) {
      const download = await page.request.get(`/api/boards/${board.id}/attachments/${id}`);
      expect(sha256(await download.body())).toBe(checksum);
    }

    writeFileSync(stateFile, JSON.stringify({ boardId: board.id, name: 'Admin loop', checksums, revisions: await historyCount(page.request, board.id) }));
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
    await expect.poll(async () => (await page.request.get('/api/auth/session')).status(), { timeout: 15_000 }).toBe(401);
  });

  test('basic user: exact 5 MiB boundary, one file per node, and history keeps only the latest 10 revisions', async ({ page }) => {
    const account = await login(page, env('STACK_BASIC_USER'), env('STACK_BASIC_PASSWORD'));
    expect(account.role).toBe('basic');
    await createBoard(page, 'Basic limits');
    await addRoot(page, 220, 200, 'Limited node');
    await openNotes(page);
    await page.locator('bm-notes-panel input[type=file]').setInputFiles({
      name: 'exactly-five.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(5_242_880, 3),
    });
    await expect(page.getByText('exactly-five.bin', { exact: true })).toBeVisible();
    await page.locator('bm-notes-panel input[type=file]').setInputFiles({
      name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('second'),
    });
    await expect(page.getByRole('alert').filter({ hasText: 'Only one attachment per block' })).toBeVisible();
    await page.getByRole('button', { name: 'Close notes', exact: true }).click();
    await addRoot(page, 420, 320, 'Too large node');
    await openNotes(page);
    await page.locator('bm-notes-panel input[type=file]').setInputFiles({
      name: 'one-over.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(5_242_881, 4),
    });
    await expect(page.getByRole('alert').filter({ hasText: '5 MiB' })).toBeVisible();
    await page.getByRole('button', { name: 'Close notes', exact: true }).click();
    await save(page);

    const board = (await listBoards(page.request)).find((item) => item.name === 'Basic limits')!;
    for (let version = 1; version <= 12; version++) {
      await page.getByRole('button', { name: 'Rename board', exact: true }).click();
      const input = page.getByRole('textbox', { name: 'Board name', exact: true });
      await input.fill(`Basic limits v${version}`);
      await input.press('Enter');
      await save(page);
    }
    await expect.poll(() => historyCount(page.request, board.id), { timeout: 60_000 }).toBe(10);
    await (await boards(page)).getByRole('button', { name: 'Board history' }).click();
    const history = page.getByRole('dialog', { name: 'Board history' });
    await expect(history.getByRole('button', { name: /^Inspect revision/ })).toHaveCount(10);
    await expect(history.getByText('Basic accounts keep the latest 10 revisions')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
  });
}

if (phase === 'persisted') {
  test('after a full stack restart the admin account, board, retained history and file bytes are still on the server', async ({ request }) => {
    expect(existsSync(stateFile)).toBe(true);
    const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as {
      boardId: string; name: string; checksums: Record<string, string>; revisions: number;
    };
    const origin = new URL(env('STACK_URL')).origin;
    const login = await request.post('/api/auth/login', {
      headers: { Origin: origin }, data: { username: env('STACK_ADMIN_USER'), password: env('STACK_ADMIN_PASSWORD') },
    });
    expect(login.ok()).toBe(true);
    const boards = await listBoards(request);
    expect(boards.some((board) => board.id === saved.boardId && board.name === saved.name)).toBe(true);
    expect(await historyCount(request, saved.boardId)).toBe(saved.revisions);
    for (const [id, checksum] of Object.entries(saved.checksums)) {
      const download = await request.get(`/api/boards/${saved.boardId}/attachments/${id}`);
      expect(sha256(await download.body())).toBe(checksum);
    }
    const basic = await request.post('/api/auth/login', {
      headers: { Origin: origin }, data: { username: env('STACK_BASIC_USER'), password: env('STACK_BASIC_PASSWORD') },
    });
    expect(basic.ok()).toBe(true);
    const basicBoard = (await listBoards(request)).find((board) => board.name.startsWith('Basic limits'));
    expect(basicBoard).toBeDefined();
    expect(await historyCount(request, basicBoard!.id)).toBe(10);
  });
}
