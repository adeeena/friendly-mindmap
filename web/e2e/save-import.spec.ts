import { strToU8, zipSync } from 'fflate';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Page, expect, test } from '@playwright/test';
import { MOD, addRoot, node, openApp } from './helpers';

const NOTICE = 'Sign in to save your work to the cloud.';

test.beforeEach(async ({ page }) => openApp(page));

async function openBoards(page: Page) {
  await page.getByRole('button', { name: /^Open boards\./ }).click();
  return page.getByRole('dialog', { name: 'Boards' });
}

async function importFile(page: Page, path: string): Promise<void> {
  const dialog = await openBoards(page);
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Import board…' }).click();
  await (await chooser).setFiles(path);
}

function boardFile(name: string, attachments: { id: string; name: string; mime: string; size: number }[] = []) {
  const doc = {
    id: crypto.randomUUID(), name,
    nodes: {
      one: {
        id: 'one', parentId: null, kind: 'topic', x: 100, y: 100,
        text: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Imported node' }] }] },
        ...(attachments.length ? { attachments } : {}),
      },
    },
    children: { __root__: ['one'] }, links: {}, tags: {},
    settings: { snap: true, autoAlign: false, direction: 'horizontal', minimap: false },
  };
  return { format: 'better-mindmap', schemaVersion: 2, board: { doc, camera: { x: 0, y: 0, zoom: 1 } }, attachments };
}

test('Ctrl/Cmd+S saves the text being typed locally without a success toast or download', async ({ page }) => {
  let downloaded = false;
  page.on('download', () => { downloaded = true; });
  await page.getByRole('button', { name: 'New node', exact: true }).click();
  const box = (await page.locator('.bm-viewport').boundingBox())!;
  await page.mouse.click(box.x + 200, box.y + 200);
  await page.keyboard.type('Draft still being typed');
  await page.keyboard.press(`${MOD}+s`);
  const saveToast = page.locator('.bm-toast').filter({ hasText: /saved|saving data to cloud/i });
  await expect(saveToast).toHaveCount(0);
  expect(downloaded).toBe(false);
  await page.reload();
  await expect(node(page, 'Draft still being typed')).toBeVisible();
  await expect(page.locator('.bm-save-status')).toHaveText('');
  await expect(saveToast).toHaveCount(0);
  expect(downloaded).toBe(false);
});

test('successful saves show no toast or permanent Saved label', async ({ page }) => {
  await addRoot(page, 200, 200, 'Transient');
  await page.keyboard.press(`${MOD}+s`);
  await expect(page.locator('.bm-toast').filter({ hasText: /saved|saving data to cloud/i })).toHaveCount(0);
  await expect(page.locator('.bm-save-status')).not.toHaveText('Saved');
});

test('Save and Export are separate commands; export alone downloads a file', async ({ page }) => {
  await addRoot(page, 200, 200, 'Palette');
  await page.keyboard.press(`${MOD}+k`);
  const palette = page.getByRole('dialog');
  const search = palette.getByRole('combobox');
  await search.fill('save');
  await expect(palette.getByRole('option', { name: /^File Save Ctrl\+S$|^File Save .*(Ctrl|⌘)/ })).toBeVisible();
  await search.fill('export board');
  const exportOption = palette.getByRole('option', { name: /Export board/ });
  await expect(exportOption).toBeVisible();
  await expect(exportOption).not.toContainText(/Ctrl|⌘/);
  await page.keyboard.press('Escape');
  const download = page.waitForEvent('download');
  const dialog = await openBoards(page);
  await dialog.getByRole('button', { name: 'Export board…' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.bmm\.json$/);
});

test('guest Save/Load surfaces show the exact cloud-login notice and export/import stay usable', async ({ page }) => {
  const boards = await openBoards(page);
  await expect(boards.getByText(NOTICE, { exact: true })).toBeVisible();
  await boards.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: 'Export', exact: true });
  await expect(exportDialog.getByText(NOTICE, { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press(`${MOD}+o`);
  expect(await chooser).toBeTruthy();
});

test('JSON and ZIP exports round-trip through staged import, and over-limit guest imports are rejected', async ({ page, browserName, isMobile }, testInfo) => {
  test.skip(browserName !== 'chromium' || isMobile, 'ZIP download/file-chooser round trip is exercised on Chromium');
  await addRoot(page, 200, 200, 'Round trip');
  await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Notes and attachments' }).click();
  await page.locator('bm-notes-panel input[type=file]').setInputFiles({ name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('attached bytes') });
  await expect(page.getByText('keep.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close notes', exact: true }).click();

  // ZIP with embedded files.
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: 'Export', exact: true });
  await exportDialog.getByLabel(/Embed attachments/).check();
  const download = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Export file', exact: true }).click();
  const exported = await download;
  expect(exported.suggestedFilename()).toMatch(/\.bmm\.zip$/);
  const zipPath = testInfo.outputPath('roundtrip.bmm.zip');
  await exported.saveAs(zipPath);
  await page.keyboard.press('Escape');

  await importFile(page, zipPath);
  await expect(page.getByText(/Loaded|imported/i).first()).toBeVisible();
  await expect(node(page, 'Round trip')).toBeVisible();
  await node(page, 'Round trip').click();
  await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Notes and attachments' }).click();
  await expect(page.getByText('keep.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close notes', exact: true }).click();
  await expect((await openBoards(page)).getByRole('listitem')).toHaveCount(2);
  await page.keyboard.press('Escape');

  // A guest may not import a file above 5 MiB: nothing is published.
  const big = { id: crypto.randomUUID(), name: 'big.bin', mime: 'application/octet-stream', size: 5_242_881 };
  const file = boardFile('Too large', [big]);
  const zip = zipSync({
    'board.json': strToU8(JSON.stringify({ ...file, attachments: [{ ...big, path: `attachments/${big.id}` }] })),
    [`attachments/${big.id}`]: new Uint8Array(big.size),
  });
  const folder = mkdtempSync(join(tmpdir(), 'bm-import-'));
  const rejected = join(folder, 'too-large.bmm.zip');
  writeFileSync(rejected, zip);
  await importFile(page, rejected);
  await expect(page.getByRole('alert').filter({ hasText: 'larger than the 5 MiB limit' })).toBeVisible();
  await expect((await openBoards(page)).getByRole('listitem')).toHaveCount(2);
});
