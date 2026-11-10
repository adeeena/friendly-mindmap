import AxeBuilder from '@axe-core/playwright';
import { Page, expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { MOD, addRoot, buildTree, node, openApp } from './helpers';

test.beforeEach(async ({ page }) => openApp(page));

test('bold text survives reload', async ({ page }) => {
  await addRoot(page, 200, 200, 'make bold');
  await node(page, 'make bold').press('F2');
  await expect(page.getByRole('textbox', { name: 'Node text' })).toBeFocused();
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+b`);
  await page.keyboard.press('Escape');
  await expect(node(page, 'make bold').locator('strong')).toHaveText('make bold');
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(node(page, 'make bold').locator('strong')).toHaveText('make bold');
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

test('attach an image with thumbnail and refuse files over 10 MB', async ({ page }) => {
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
  await input.setInputFiles({ name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(11 * 1024 * 1024) });
  await expect(page.locator('bm-notes-panel .bm-error')).toContainText('10 MB');
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
  /** pixels that are not backdrop: opaque-and-different from the corner colour, or any alpha when the corner is transparent */
  content: number;
  /** content pixels in the probed image column */
  columnContent: number;
}

/** Exports the board as PNG through the dialog and decodes the downloaded file in the browser. */
async function exportPng(
  page: Page,
  opts: { background: boolean; selectionOnly?: boolean; probeX?: number },
): Promise<PngStats> {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /Save/ });
  await dialog.getByRole('tab', { name: 'Image' }).click();
  await dialog.getByRole('radio', { name: '1x' }).check();
  const bg = dialog.getByLabel('Background');
  if ((await bg.isChecked()) !== opts.background) await bg.setChecked(opts.background);
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
      return { width: bmp.width, height: bmp.height, cornerAlpha: corner[3], content, columnContent };
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

test('PNG image export downloads a file', async ({ page }) => {
  await buildTree(page);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /Save/ });
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
    await page.getByRole('button', { name: /^Boards\./ }).click();
    await check();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Tags and filter' }).click();
    await check();
  });
}
