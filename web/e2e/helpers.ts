import { Page, expect } from '@playwright/test';

export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.bm-save-status[data-status="saved"]')).toBeAttached();
}

export function nodes(page: Page) {
  return page.locator('[data-node-id]');
}

export function node(page: Page, label: string) {
  return page.getByRole('treeitem', { name: label, exact: true });
}

/** Creates a root node at viewport coordinates and types its text. */
export async function addRoot(page: Page, x: number, y: number, text: string): Promise<void> {
  await page.getByRole('button', { name: 'New node', exact: true }).click();
  const box = (await page.locator('.bm-viewport').boundingBox())!;
  await page.mouse.click(box.x + x, box.y + y);
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
  await expect(node(page, text)).toBeFocused();
}

/** Builds Root -> [A -> [A1], B] using keyboard only. */
export async function buildTree(page: Page): Promise<void> {
  await addRoot(page, 200, 200, 'Root');
  await page.keyboard.press('Tab');
  await page.keyboard.type('A');
  await page.keyboard.press('Tab');
  await page.keyboard.type('A1');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(node(page, 'Root')).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.type('B');
  await page.keyboard.press('Escape');
  await expect(node(page, 'B')).toBeFocused();
}

export async function rect(page: Page, label: string) {
  // Let pending signal updates render before measuring.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return (await node(page, label).boundingBox())!;
}

export function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export async function setToggle(page: Page, name: string, on: boolean): Promise<void> {
  const btn = page.getByRole('button', { name, exact: true });
  if ((await btn.getAttribute('aria-pressed')) !== String(on)) await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', String(on));
}
