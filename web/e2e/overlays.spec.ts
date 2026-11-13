import { Locator, Page, expect, test } from '@playwright/test';
import { MOD, addRoot, openApp } from './helpers';

test.beforeEach(async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || isMobile, 'popover geometry is asserted on desktop Chromium; WebKit/mobile are covered by the AXE and layout suites');
  await openApp(page);
});

const tagsButton = (page: Page) => page.locator('[data-view-control="tags"]');
const minimapButton = (page: Page) => page.locator('[data-view-control="minimap"]');

async function box(locator: Locator) {
  return (await locator.boundingBox())!;
}

/** The popover must hug its trigger (above or below), overlap its horizontal extent and stay inside the viewport. */
async function expectAnchored(page: Page, popover: Locator, trigger: Locator): Promise<void> {
  const [p, b] = [await box(popover), await box(trigger)];
  const view = page.viewportSize()!;
  expect(p.x).toBeGreaterThanOrEqual(0);
  expect(p.y).toBeGreaterThanOrEqual(0);
  expect(p.x + p.width).toBeLessThanOrEqual(view.width + 0.5);
  expect(p.y + p.height).toBeLessThanOrEqual(view.height + 0.5);
  const gap = p.y + p.height <= b.y ? b.y - (p.y + p.height) : p.y - (b.y + b.height);
  expect(gap).toBeGreaterThanOrEqual(-1);
  expect(gap).toBeLessThanOrEqual(16);
  expect(p.x).toBeLessThanOrEqual(b.x + b.width);
  expect(p.x + p.width).toBeGreaterThanOrEqual(b.x);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('minimap, tags and zoom controls share a bottom-right group with a vertical separator', async ({ page }) => {
  const view = page.viewportSize()!;
  const group = page.getByRole('group', { name: 'View and zoom controls' });
  const controls = [page.getByRole('button', { name: 'Zoom out' }), minimapButton(page), tagsButton(page)];
  for (const button of controls) {
    const b = await box(button);
    expect(b.x).toBeGreaterThan(view.width * 2 / 3);
    expect(b.y + b.height).toBeGreaterThan(view.height - 120);
    await expect(button).toBeVisible();
  }
  const [m, t] = [await box(minimapButton(page)), await box(tagsButton(page))];
  expect(Math.abs(m.y - t.y)).toBeLessThan(4);
  const [separator, zoomFit, mini] = await Promise.all([
    box(group.locator('.bm-corner-sep')),
    box(page.getByRole('button', { name: 'Fit to screen' })),
    box(minimapButton(page)),
  ]);
  expect(separator.height).toBeGreaterThan(16);
  expect(separator.width).toBe(1);
  expect(separator.x).toBeGreaterThan(zoomFit.x + zoomFit.width);
  expect(separator.x).toBeLessThan(mini.x);
  await expect(minimapButton(page)).toHaveAttribute('title', /^Minimap \(M\)$/);
});

test('keyboard focus shows the tooltip directly above its own bottom-right button', async ({ page }) => {
  await minimapButton(page).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  const tooltip = await minimapButton(page).evaluate((element) => {
    const style = getComputedStyle(element, '::after');
    return { content: style.content, position: style.position, bottom: style.bottom, height: element.getBoundingClientRect().height };
  });
  expect(tooltip.content).toContain('Minimap');
  expect(tooltip.position).toBe('absolute');
  const bottom = parseFloat(tooltip.bottom);
  expect(bottom).toBeGreaterThanOrEqual(tooltip.height);
  expect(bottom).toBeLessThanOrEqual(tooltip.height + 8);
});

test('the tag popover opens beside its trigger, survives pan/zoom and resize, and Escape restores focus', async ({ page }) => {
  await addRoot(page, 300, 200, 'Anchor board');
  for (let i = 0; i < 3; i++) await page.keyboard.press(`${MOD}+=`);
  const viewport = await box(page.locator('.bm-viewport'));
  await page.mouse.move(viewport.x + 600, viewport.y + 300);
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(viewport.x + 500, viewport.y + 250);
  await page.mouse.up();
  await page.keyboard.up('Space');

  await tagsButton(page).click();
  const popover = page.getByRole('dialog', { name: 'Tags' });
  await expect(popover).toBeVisible();
  await expectAnchored(page, popover, tagsButton(page));
  await page.setViewportSize({ width: 900, height: 600 });
  await expectAnchored(page, popover, tagsButton(page));
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(tagsButton(page)).toBeFocused();
});

test('at 375px the tag popover stays reachable and creates no horizontal scrolling, also after resizing', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await tagsButton(page).click();
  const popover = page.getByRole('dialog', { name: 'Tags' });
  await expect(popover).toBeVisible();
  await expectAnchored(page, popover, tagsButton(page));
  await page.setViewportSize({ width: 360, height: 640 });
  await expectAnchored(page, popover, tagsButton(page));
  await popover.getByRole('textbox', { name: 'New tag name' }).fill('work');
  await popover.getByRole('button', { name: 'Add' }).click();
  await expectAnchored(page, popover, tagsButton(page));
  await page.keyboard.press('Escape');
  await expect(tagsButton(page)).toBeFocused();
});

test('the minimap opens above its button and Save/Load/Export are all in the toolbar', async ({ page }) => {
  await minimapButton(page).click();
  const map = page.locator('bm-minimap');
  await expect(map).toBeVisible();
  const [m, b] = [await box(map), await box(minimapButton(page))];
  expect(m.y + m.height).toBeLessThanOrEqual(b.y + 1);
  const controls = await box(page.locator('.bm-view-zoom-group'));
  expect(Math.abs(m.x + m.width - (controls.x + controls.width))).toBeLessThan(4);
  const toolbar = page.getByRole('group', { name: 'File' });
  await expect(toolbar.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Load', exact: true })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
});
