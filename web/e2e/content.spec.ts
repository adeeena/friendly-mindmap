import AxeBuilder from '@axe-core/playwright';
import { Page, expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { MOD, addRoot, buildTree, node, openApp } from './helpers';

test.beforeEach(async ({ page }) => openApp(page));

test('text formatting survives reload', async ({ page }) => {
  await addRoot(page, 200, 200, 'make bold');
  await node(page, 'make bold').press('F2');
  await expect(page.getByRole('textbox', { name: 'Node text' })).toBeFocused();
  const selectionToolbar = page.getByRole('toolbar', { name: 'Selection' });
  await expect(selectionToolbar).toBeVisible();
  for (const name of ['Color', 'Emoji', 'Tags', 'Delete']) {
    await expect(selectionToolbar.getByRole('button', { name })).toBeVisible();
  }
  await page.keyboard.press(`${MOD}+a`);
  for (const mark of ['Bold', 'Italic', 'Underline']) {
    const button = page.getByRole('button', { name: mark });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }
  await page.keyboard.press('Escape');
  await expect(node(page, 'make bold').locator('strong')).toHaveText('make bold');
  await expect(node(page, 'make bold').locator('em')).toHaveText('make bold');
  await expect(node(page, 'make bold').locator('u')).toHaveText('make bold');
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(node(page, 'make bold').locator('strong')).toHaveText('make bold');
  await expect(node(page, 'make bold').locator('em')).toHaveText('make bold');
  await expect(node(page, 'make bold').locator('u')).toHaveText('make bold');
});

test('unsafe links are rejected in the link form', async ({ page }) => {
  await addRoot(page, 200, 200, 'link me');
  await node(page, 'link me').press('F2');
  await expect(page.getByRole('textbox', { name: 'Node text' })).toBeFocused();
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+k`);
  const input = page.getByLabel('Link URL');
  await input.fill('javascript:alert(1)');
  await input.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Only http');
  await input.fill('https://example.com');
  await input.press('Enter');
  await page.keyboard.press('Escape');
  const link = node(page, 'link me').locator('a');
  await expect(link).toHaveAttribute('href', 'https://example.com');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});

test('tag filter emphasizes tagged (and inheriting) nodes', async ({ page }) => {
  await buildTree(page);
  await page.getByRole('button', { name: 'Tags and filter' }).click();
  const dialog = page.getByRole('dialog', { name: 'Tags' });
  await dialog.getByLabel('New tag name').fill('work');
  await dialog.getByRole('button', { name: 'Add' }).click();
  await dialog.getByRole('button', { name: 'Close' }).click();

  await node(page, 'A').click();
  await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Tags' }).click();
  await page.getByRole('menuitemcheckbox', { name: /work/ }).click();
  await expect(node(page, 'A1').locator('.bm-chip')).toHaveText('work');

  await page.keyboard.press(`${MOD}+k`);
  await page.getByRole('combobox').fill('filter by tag: work');
  await page.keyboard.press('Enter');
  await expect(node(page, 'A')).not.toHaveClass(/dimmed/);
  await expect(node(page, 'A1')).not.toHaveClass(/dimmed/);
  await expect(node(page, 'B')).toHaveClass(/dimmed/);
  await expect(node(page, 'Root')).toHaveClass(/dimmed/);
});

test('notes panel edits a note and passes AXE', async ({ page }) => {
  await addRoot(page, 200, 200, 'Has note');
  await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Notes and attachments' }).click();
  const panel = page.getByRole('complementary', { name: /Notes/ });
  await expect(panel).toBeVisible();
  await panel.getByRole('textbox', { name: 'Note' }).click();
  await page.keyboard.type('Remember this');
  await expect(node(page, 'Has note').getByRole('button', { name: 'Open note' })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
});

test('attach an image with thumbnail and enforce guest size/count limits', async ({ page }) => {
  await addRoot(page, 200, 200, 'Files');
  await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Notes and attachments' }).click();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const input = page.locator('bm-notes-panel input[type=file]');
  await input.setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText('dot.png')).toBeVisible();
  await expect(page.locator('bm-notes-panel img.bm-thumb')).toHaveCount(1);
  await expect(node(page, 'Files').getByRole('button', { name: '1 attachments' })).toBeVisible();
  await input.setInputFiles({ name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(5_242_881) });
  await expect(page.locator('bm-notes-panel .bm-error')).toContainText('5 MiB');
  await input.setInputFiles({ name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('second') });
  await expect(page.locator('bm-notes-panel .bm-error')).toContainText('one attachment per block');
});

test('shopping list checklist shows progress', async ({ page }) => {
  await page.getByRole('button', { name: /New node shape/ }).click();
  await page.getByRole('menuitemradio', { name: 'Checklist' }).click();
  const box = (await page.locator('.bm-viewport').boundingBox())!;
  await page.mouse.click(box.x + 200, box.y + 200);
  await page.keyboard.type('Groceries');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '+ Add item' }).click();
  await page.keyboard.type('milk');
  await page.keyboard.press('Enter');
  await page.keyboard.type('eggs');
  await page.getByRole('checkbox', { name: 'Done: milk' }).check();
  const list = page.getByRole('treeitem', { name: /Groceries, checklist/ });
  await expect(list).toContainText('1/2');
  const item2 = page.getByRole('textbox', { name: 'Item 2' });
  await item2.fill('');
  await item2.press('Backspace');
  await expect(list).toContainText('1/1');
});

test('todo children show checkboxes and progress', async ({ page }) => {
  await buildTree(page);
  await node(page, 'Root').click();
  await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Todo list for children' }).click();
  await page.getByRole('checkbox', { name: 'Done: B' }).check();
  await expect(page.getByRole('treeitem', { name: /^Root/ })).toContainText('1/2');
});

interface PngStats {
  width: number;
  height: number;
  cornerAlpha: number;
  corner: number[];
  /** pixels that are not backdrop: opaque-and-different from the corner colour, or any alpha when the corner is transparent */
  content: number;
  /** content pixels in the probed image column */
  columnContent: number;
}

/** Exports the board as PNG through the dialog and decodes the downloaded file in the browser. */
async function exportPng(
  page: Page,
  opts: { background: boolean; selectionOnly?: boolean; probeX?: number; lightTheme?: boolean },
): Promise<PngStats> {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
  await dialog.getByRole('tab', { name: 'Image' }).click();
  await dialog.getByRole('radio', { name: '1x' }).check();
  const bg = dialog.getByLabel('Background');
  if ((await bg.isChecked()) !== opts.background) await bg.setChecked(opts.background);
  if (opts.lightTheme !== undefined) await dialog.getByLabel('Light theme').setChecked(opts.lightTheme);
  if (opts.selectionOnly) await dialog.getByRole('radio', { name: 'Selection' }).check();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export image' }).click();
  const file = await (await download).path();
  const b64 = readFileSync(file).toString('base64');
  await page.keyboard.press('Escape');
  return page.evaluate(
    async ({ data, probeX }) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      const at = (i: number) => [px[i], px[i + 1], px[i + 2], px[i + 3]];
      const corner = at(0);
      const isContent = (i: number) => {
        const [r, g, b, a] = at(i);
        if (corner[3] === 0) return a > 0;
        return a > 0 && (Math.abs(r - corner[0]) > 12 || Math.abs(g - corner[1]) > 12 || Math.abs(b - corner[2]) > 12);
      };
      let content = 0;
      let columnContent = 0;
      for (let y = 0; y < bmp.height; y++) {
        for (let x = 0; x < bmp.width; x++) {
          if (!isContent((y * bmp.width + x) * 4)) continue;
          content++;
          if (x === probeX) columnContent++;
        }
      }
      return { width: bmp.width, height: bmp.height, cornerAlpha: corner[3], corner, content, columnContent };
    },
    { data: b64, probeX: opts.probeX ?? -1 },
  );
}

/** Image column (1x export, 32 px padding) at the centre of the gap between Root and A, where only the edge lies. */
async function edgeColumn(page: Page): Promise<number> {
  const root = (await node(page, 'Root').boundingBox())!;
  const a = (await node(page, 'A').boundingBox())!;
  const all = await Promise.all(['Root', 'A', 'A1', 'B'].map(async (l) => (await node(page, l).boundingBox())!));
  const left = Math.min(...all.map((r) => r.x));
  return Math.round(32 + ((root.x + root.width + a.x) / 2 - left));
}

test.describe('PNG export pixels', () => {
  test('with background: opaque canvas, nodes and the edge between them are drawn', async ({ page }) => {
    await buildTree(page);
    const stats = await exportPng(page, { background: true, probeX: await edgeColumn(page) });
    expect(stats.cornerAlpha).toBe(255);
    expect(stats.content).toBeGreaterThan(500);
    expect(stats.columnContent).toBeGreaterThan(0);
  });

  test('without background: transparent around the map, nodes and edges still visible', async ({ page }) => {
    await buildTree(page);
    const stats = await exportPng(page, { background: false, probeX: await edgeColumn(page) });
    expect(stats.cornerAlpha).toBe(0);
    expect(stats.content).toBeGreaterThan(500);
    expect(stats.columnContent).toBeGreaterThan(0);
  });

  test('selection export contains only the selected nodes', async ({ page }) => {
    await buildTree(page);
    const whole = await exportPng(page, { background: false });
    await node(page, 'A').click();
    const part = await exportPng(page, { background: false, selectionOnly: true });
    expect(part.content).toBeGreaterThan(100);
    expect(part.content).toBeLessThan(whole.content);
    expect(part.width * part.height).toBeLessThan(whole.width * whole.height);
  });
});

const EXPORT_THEMES = ['system', 'light', 'dark', 'pale-rose'] as const;

async function storedDocs(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('better-mindmap');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const boards = await new Promise<{ doc: unknown }[]>((resolve, reject) => {
      const request = db.transaction('boards').objectStore('boards').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return JSON.stringify(boards.map((board) => board.doc));
  });
}

for (const theme of EXPORT_THEMES) {
  test(`image export keeps board data and restores the ${theme} app theme`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'the pixel probe needs OffscreenCanvas, which this WebKit build lacks (the existing PNG pixel tests share the limit)');
    await page.evaluate((value) => localStorage.setItem('friendly-mindmap.settings', JSON.stringify({ theme: value, language: 'en' })), theme);
    await page.reload();
    await buildTree(page);
    await page.waitForTimeout(1000);
    const html = page.locator('html');
    const applied = await html.getAttribute('data-theme');
    const docs = await storedDocs(page);
    const backdrop = await page.evaluate(() => {
      const hex = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
    });
    const themed = await exportPng(page, { background: true, lightTheme: false });
    expect(themed.corner.slice(0, 3)).toEqual(backdrop);
    expect(await html.getAttribute('data-theme')).toBe(applied);
    await expect(html).not.toHaveClass(/force-light|exporting/);
    const light = await exportPng(page, { background: true, lightTheme: true });
    expect(light.corner.slice(0, 3)).toEqual([0xf7, 0xf7, 0xf8]);
    expect(light.content).toBeGreaterThan(500);
    expect(await html.getAttribute('data-theme')).toBe(applied);
    await expect(html).not.toHaveClass(/force-light|exporting/);
    expect(await storedDocs(page)).toBe(docs);
  });
}

test('print view stays white-on-dark-text under every active app theme', async ({ page, context }) => {
  await buildTree(page);
  await node(page, 'Root').click();
  await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Todo list for children' }).click();
  await page.waitForTimeout(1000);
  const [doc] = JSON.parse(await storedDocs(page)) as { id: string; nodes: Record<string, { id: string; text: unknown }> }[];
  const root = Object.values(doc.nodes).find((n) => JSON.stringify(n.text).includes('Root'))!;
  for (const theme of ['dark', 'pale-rose']) {
    await page.evaluate((value) => localStorage.setItem('friendly-mindmap.settings', JSON.stringify({ theme: value, language: 'en' })), theme);
    const print = await context.newPage();
    await print.addInitScript(() => { window.print = () => undefined; });
    await print.goto(`/print/${doc.id}/${root.id}?w=guest`);
    await expect(print.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(print.getByRole('heading', { name: 'Root' })).toBeVisible();
    await expect(print.locator('bm-checklist-print')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(print.locator('bm-checklist-print')).toHaveCSS('color', 'rgb(17, 17, 17)');
    await print.close();
  }
});

test('PNG image export downloads a file', async ({ page }) => {
  await buildTree(page);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
  await dialog.getByRole('tab', { name: 'Image' }).click();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export image' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.png$/);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`AXE: populated board and dialogs in ${scheme} mode`, async ({ page }) => {
    const check = async () => {
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`)).toEqual([]);
    };
    await page.emulateMedia({ colorScheme: scheme });
    await check();
    await buildTree(page);
    await node(page, 'A').click();
    await check();
    await page.keyboard.press(`${MOD}+k`);
    await check();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await check();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Open boards\./ }).click();
    await check();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Tags and filter' }).click();
    await check();
  });
}
