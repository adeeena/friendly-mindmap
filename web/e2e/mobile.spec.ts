import { Page, expect, test } from '@playwright/test';
import { addRoot, node, openApp, rect } from './helpers';

test.beforeEach(async ({ page, isMobile }) => {
  test.skip(!isMobile, 'touch-only scenarios');
  await openApp(page);
});

async function touch(page: Page, type: string, x: number, y: number, pointerId = 7): Promise<void> {
  await page.evaluate(
    ({ type, x, y, pointerId }) => {
      const target = document.elementFromPoint(x, y) ?? document.body;
      target.dispatchEvent(
        new PointerEvent(type, {
          pointerId,
          pointerType: 'touch',
          isPrimary: pointerId === 7,
          clientX: x,
          clientY: y,
          button: type === 'pointermove' ? -1 : 0,
          buttons: type === 'pointerup' ? 0 : 1,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { type, x, y, pointerId },
  );
}

test('tap selects, double-tap edits', async ({ page }) => {
  await addRoot(page, 120, 200, 'Tap me');
  await page.locator('.bm-viewport').tap({ position: { x: 20, y: 500 } });
  await expect(node(page, 'Tap me')).toHaveAttribute('aria-selected', 'false');
  const r = await rect(page, 'Tap me');
  await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
  await expect(node(page, 'Tap me')).toHaveAttribute('aria-selected', 'true');
  await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
  await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
  await expect(page.getByRole('textbox', { name: 'Node text' })).toBeVisible();
});

test('long-press opens the node context menu', async ({ page }) => {
  await addRoot(page, 120, 200, 'Hold');
  const r = await rect(page, 'Hold');
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  await touch(page, 'pointerdown', x, y);
  await page.waitForTimeout(650);
  await touch(page, 'pointerup', x, y);
  const menu = page.getByRole('menu', { name: 'Node actions' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Add child' }).tap();
  await expect(page.getByRole('textbox', { name: 'Node text' })).toBeVisible();
});

test('drag moves a node (free mode)', async ({ page }) => {
  await page.getByRole('button', { name: 'Auto align' }).tap();
  await addRoot(page, 80, 160, 'Drag');
  const r = await rect(page, 'Drag');
  const x = r.x + 10;
  const y = r.y + 10;
  await touch(page, 'pointerdown', x, y);
  for (let i = 1; i <= 5; i++) {
    await touch(page, 'pointermove', x + i * 16, y + i * 12);
    await page.waitForTimeout(20);
  }
  await touch(page, 'pointerup', x + 80, y + 60);
  const after = await rect(page, 'Drag');
  expect(after.x - r.x).toBeGreaterThan(50);
  expect(after.y - r.y).toBeGreaterThan(30);
});

test('two-finger pinch zooms', async ({ page }) => {
  const vp = (await page.locator('.bm-viewport').boundingBox())!;
  const cx = vp.x + vp.width / 2;
  const cy = vp.y + vp.height / 2;
  await touch(page, 'pointerdown', cx - 40, cy, 7);
  await touch(page, 'pointerdown', cx + 40, cy, 8);
  await touch(page, 'pointermove', cx + 120, cy, 8);
  await page.waitForTimeout(50);
  await touch(page, 'pointerup', cx + 120, cy, 8);
  await touch(page, 'pointerup', cx - 40, cy, 7);
  await expect(page.getByRole('button', { name: 'Reset zoom to 100%' })).toHaveText(/2\d\d%/);
});
