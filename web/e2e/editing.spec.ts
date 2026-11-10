import { expect, test } from '@playwright/test';
import { MOD, addRoot, buildTree, node, nodes, openApp, overlaps, rect } from './helpers';

test.beforeEach(async ({ page }) => openApp(page));

test('Tab creates child, Enter sibling, Shift+Enter line break', async ({ page, isMobile }) => {
  await addRoot(page, 200, 200, 'Plan');
  await page.keyboard.press('Enter');
  await expect(nodes(page)).toHaveCount(2);
  await page.keyboard.press('Escape');
  await page.keyboard.press(`${MOD}+z`);
  await expect(nodes(page)).toHaveCount(1);

  await node(page, 'Plan').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.type('Ideas');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Tasks');
  if (!isMobile) {
    // ProseMirror re-dispatches Enter on iOS without Shift, so the line break is desktop-only.
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('today');
  }
  await page.keyboard.press('Escape');

  await expect(node(page, 'Ideas')).toHaveAttribute('aria-level', '2');
  const tasks = page.getByRole('treeitem', { name: /Tasks/ });
  await expect(tasks).toHaveAttribute('aria-level', '2');
  if (!isMobile) await expect(tasks.locator('br')).toHaveCount(1);
  await expect(tasks).toBeFocused();
});

test('caret stays inside the node while editing at 250% zoom', async ({ page }) => {
  await addRoot(page, 150, 150, 'Zoomed');
  await page.getByRole('button', { name: 'Fit to screen' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.getByRole('button', { name: 'Reset zoom to 100%' })).toHaveText(/2\d\d%/);
  await node(page, 'Zoomed').dblclick();
  await expect(page.getByRole('textbox', { name: 'Node text' })).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  const inside = await page.evaluate(() => {
    const sel = window.getSelection()!;
    const caret = sel.getRangeAt(0).getBoundingClientRect();
    const host = document.querySelector('.bm-node.editing')!.getBoundingClientRect();
    return caret.left >= host.left && caret.right <= host.right + 2 && caret.top >= host.top - 2 && caret.bottom <= host.bottom + 2;
  });
  expect(inside).toBe(true);
  await page.keyboard.press('Escape');
  await expect(node(page, 'Zoomed!')).toBeVisible();
});

test('auto align places a new child without overlapping siblings', async ({ page }) => {
  await buildTree(page);
  await node(page, 'Root').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.type('C is a much longer node text');
  await page.keyboard.press('Escape');
  const labels = ['Root', 'A', 'A1', 'B', 'C is a much longer node text'];
  const boxes = await Promise.all(labels.map((l) => rect(page, l)));
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j]), `${labels[i]} vs ${labels[j]}`).toBe(false);
});

test('keyboard-only: build and navigate a 3-level tree', async ({ page }) => {
  await buildTree(page);
  await expect(node(page, 'B')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(node(page, 'A')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(node(page, 'A1')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(node(page, 'A')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(node(page, 'B')).toBeFocused();
  await page.keyboard.press(`${MOD}+ArrowUp`);
  await expect(node(page, 'B')).toHaveAttribute('aria-posinset', '1');
  await node(page, 'A').focus();
  await page.keyboard.press(`${MOD}+.`);
  await expect(node(page, 'A1')).toHaveCount(0);
  await expect(page.getByRole('treeitem', { name: /^A, 1 hidden/ })).toBeVisible();
  await page.keyboard.press('F2');
  await page.keyboard.press('End');
  await page.keyboard.type('x');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('treeitem', { name: /^Ax/ })).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(nodes(page)).toHaveCount(2);
  await expect(node(page, 'Root')).toBeFocused();
});

test('typing on a selected node replaces its text', async ({ page }) => {
  await addRoot(page, 200, 200, 'Old');
  await page.keyboard.type('New');
  await page.keyboard.press('Escape');
  await expect(node(page, 'New')).toBeVisible();
});

test('copy, paste and duplicate subtrees', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
  await buildTree(page);
  await node(page, 'A').focus();
  await expect(node(page, 'A')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press(`${MOD}+d`);
  await expect(page.getByRole('treeitem', { name: 'A1', exact: true })).toHaveCount(2);
  await page.keyboard.press(`${MOD}+z`);
  await expect(page.getByRole('treeitem', { name: 'A1', exact: true })).toHaveCount(1);
});
