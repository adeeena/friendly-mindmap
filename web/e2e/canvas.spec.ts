import { expect, test } from '@playwright/test';
import { MOD, addRoot, buildTree, node, nodes, openApp, rect, setToggle } from './helpers';

test.beforeEach(async ({ page }) => openApp(page));

test('zoom keeps the point under the cursor fixed', async ({ page, isMobile }) => {
  test.skip(isMobile, 'wheel zoom is desktop-only');
  await addRoot(page, 300, 250, 'Anchor');
  const before = await rect(page, 'Anchor');
  const cx = before.x + before.width / 2;
  const cy = before.y + before.height / 2;
  await page.mouse.move(cx, cy);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await expect(page.getByRole('button', { name: 'Reset zoom to 100%' })).not.toHaveText(/^\s*100%\s*$/);
  const after = await rect(page, 'Anchor');
  expect(after.width).toBeGreaterThan(before.width);
  expect(Math.abs(after.x + after.width / 2 - cx)).toBeLessThan(3);
  expect(Math.abs(after.y + after.height / 2 - cy)).toBeLessThan(3);
});

test('marquee selects only fully enclosed nodes', async ({ page, isMobile }) => {
  test.skip(isMobile, 'mouse marquee');
  await addRoot(page, 120, 150, 'Inside');
  await addRoot(page, 120, 350, 'Partial');
  await page.keyboard.press('Escape');
  const a = await rect(page, 'Inside');
  const b = await rect(page, 'Partial');
  await page.mouse.move(a.x - 20, a.y - 20);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width + 40, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(node(page, 'Inside')).toHaveAttribute('aria-selected', 'true');
  await expect(node(page, 'Partial')).toHaveAttribute('aria-selected', 'false');
});

test('free drag moves the node with grid snap and undo restores it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'mouse drag');
  await setToggle(page, 'Auto align', false);
  await addRoot(page, 120, 150, 'Mover');
  const start = await rect(page, 'Mover');
  await page.mouse.move(start.x + 10, start.y + 10);
  await page.mouse.down();
  await page.mouse.move(start.x + 110, start.y + 70, { steps: 8 });
  await page.mouse.up();
  const end = await rect(page, 'Mover');
  expect(end.x - start.x).toBeGreaterThan(90);
  expect(end.y - start.y).toBeGreaterThan(50);
  await page.keyboard.press(`${MOD}+z`);
  const back = await rect(page, 'Mover');
  expect(Math.round(back.x)).toBe(Math.round(start.x));
});

test('connect tool creates a cross-link that can be deleted', async ({ page, isMobile }) => {
  test.skip(isMobile, 'mouse drag');
  await addRoot(page, 120, 150, 'From');
  await addRoot(page, 420, 350, 'To');
  await page.getByRole('button', { name: 'New connection', exact: true }).click();
  const a = await rect(page, 'From');
  const b = await rect(page, 'To');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
  const link = page.locator('.bm-link:not(.preview)');
  await expect(link).toHaveCount(1);
  await page.keyboard.press('p');
  const hit = page.locator('[data-edge^="l:"]');
  const box = (await hit.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.bm-link.selected')).toHaveCount(1);
  await page.keyboard.press('Delete');
  await expect(link).toHaveCount(0);
  await expect(nodes(page)).toHaveCount(2);
});

test('auto align: dragging B2 onto A reparents it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'mouse drag');
  await addRoot(page, 120, 120, 'A');
  await addRoot(page, 120, 380, 'B');
  await page.keyboard.press('Tab');
  await page.keyboard.type('B2');
  await page.keyboard.press('Escape');
  const from = await rect(page, 'B2');
  const to = await rect(page, 'A');
  await page.mouse.move(from.x + 8, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await expect(node(page, 'A')).toHaveClass(/drop-target/);
  await page.mouse.up();
  await expect(node(page, 'B2')).toHaveAttribute('aria-level', '2');
  await expect(node(page, 'A')).toHaveAttribute('aria-expanded', 'true');
  await expect(node(page, 'B')).not.toHaveAttribute('aria-expanded', /.+/);
});

test('command palette runs Vertical layout', async ({ page }) => {
  await buildTree(page);
  await page.keyboard.press(`${MOD}+k`);
  const input = page.getByRole('combobox');
  await expect(input).toBeFocused();
  await input.fill('vert');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Layout direction: vertical' })).toBeVisible();
  const root = await rect(page, 'Root');
  const a = await rect(page, 'A');
  expect(a.y).toBeGreaterThan(root.y + root.height);
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('combobox')).toHaveCount(0);
});

test('fit to screen and minimap navigation', async ({ page }) => {
  await buildTree(page);
  await page.getByRole('button', { name: 'Fit to screen' }).click();
  const vp = (await page.locator('.bm-viewport').boundingBox())!;
  for (const l of ['Root', 'A', 'A1', 'B']) {
    const r = await rect(page, l);
    expect(r.x).toBeGreaterThanOrEqual(vp.x);
    expect(r.x + r.width).toBeLessThanOrEqual(vp.x + vp.width);
  }
  await setToggle(page, 'Minimap', true);
  const mini = page.locator('bm-minimap svg');
  const before = await rect(page, 'Root');
  const mb = (await mini.boundingBox())!;
  await page.mouse.click(mb.x + 5, mb.y + 5);
  await expect
    .poll(async () => {
      const after = await rect(page, 'Root');
      return Math.abs(after.x - before.x) + Math.abs(after.y - before.y);
    })
    .toBeGreaterThan(10);
});

test('toolbar fits a 375px wide screen without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await page.reload();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  for (const name of ['Pointer', 'Hand', 'New node', 'Auto align', 'Undo', 'Export', 'Command palette']) {
    const btn = page.getByRole('button', { name, exact: true });
    await btn.scrollIntoViewIfNeeded();
    await expect(btn).toBeVisible();
  }
});
