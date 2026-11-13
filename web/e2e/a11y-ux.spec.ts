import AxeBuilder from '@axe-core/playwright';
import { Page, expect, test } from '@playwright/test';
import { node } from './helpers';

const SETTINGS_KEY = 'friendly-mindmap.settings';
const LANGUAGES = ['en', 'fr', 'hu'] as const;
const THEMES = ['light', 'dark', 'pale-rose'] as const;
const SETTINGS_LABEL: Record<(typeof LANGUAGES)[number], string> = {
  en: 'Settings',
  fr: 'Paramètres',
  hu: 'Beállítások',
};

async function openIn(page: Page, language: string, theme: string): Promise<void> {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [SETTINGS_KEY, JSON.stringify({ language, theme })],
  );
  await page.goto('/');
  await expect(page.locator('.bm-save-status[data-status="saved"]')).toBeAttached();
  await expect(page.locator('html')).toHaveAttribute('lang', language);
}

async function expectNoViolations(page: Page, include?: string): Promise<void> {
  const builder = new AxeBuilder({ page });
  if (include) builder.include(include);
  const results = await builder.analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`)).toEqual([]);
}

for (const language of LANGUAGES) {
  for (const theme of THEMES) {
    test(`AXE: settings popup and line menu in ${language} / ${theme}`, async ({ page, isMobile }) => {
      await openIn(page, language, theme);

      await page.getByRole('button', { name: SETTINGS_LABEL[language], exact: true }).click();
      const settings = page.locator('bm-settings-dialog');
      await expect(settings).toBeVisible();
      const tabs = settings.getByRole('tab');
      await expect(tabs).toHaveCount(2);
      for (let i = 0; i < 2; i++) {
        await tabs.nth(i).click();
        await expectNoViolations(page);
      }
      // Keyboard: the dialog is operable and Escape returns to the board.
      await page.keyboard.press('Tab');
      await expect(settings.locator(':focus')).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(settings).toHaveCount(0);

      test.skip(isMobile, 'mouse right-click');
      await page.keyboard.press('n');
      const vp = (await page.locator('.bm-viewport').boundingBox())!;
      await page.mouse.click(vp.x + 120, vp.y + 120);
      await page.keyboard.type('Parent');
      await page.keyboard.press('Escape');
      await expect(node(page, 'Parent')).toBeFocused();
      await page.keyboard.press('Tab');
      await page.keyboard.type('Child');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      const box = (await page.locator('[data-edge^="h:"]').boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
      const menu = page.locator('bm-edge-menu');
      await expect(menu).toBeVisible();
      await expectNoViolations(page);
      // The first control gets focus and every option is reachable with the keyboard.
      await expect(menu.locator('button').first()).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(menu.locator(':focus')).toHaveCount(1);
      await page.keyboard.press('Enter');
      await expect(node(page, 'Child')).toBeAttached();
    });
  }
}

for (const theme of THEMES) {
  test(`AXE: emoji bar and picker in ${theme}`, async ({ page }) => {
    await openIn(page, 'en', theme);
    await page.keyboard.press('n');
    const vp = (await page.locator('.bm-viewport').boundingBox())!;
    await page.mouse.click(vp.x + 160, vp.y + 220);
    await page.keyboard.type('Task');
    await page.keyboard.press('Escape');
    const bar = page.getByRole('toolbar', { name: 'Quick emoji' });
    await expect(bar).toBeVisible();
    await expectNoViolations(page);
    await bar.getByRole('button', { name: 'More emoji…' }).click();
    await expect(page.getByRole('dialog', { name: 'Emoji picker' })).toBeVisible();
    await expectNoViolations(page);
  });
}

for (const theme of THEMES) {
  test(`AXE: color palette menu and tag colors in ${theme}`, async ({ page }) => {
    await openIn(page, 'en', theme);
    await page.keyboard.press('n');
    const vp = (await page.locator('.bm-viewport').boundingBox())!;
    await page.mouse.click(vp.x + 160, vp.y + 160);
    await page.keyboard.type('Colored');
    await page.keyboard.press('Escape');
    await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Color' }).click();
    const rose = page.getByRole('menuitemradio', { name: 'Rose' });
    await expect(rose).toBeVisible();
    await expectNoViolations(page);
    await rose.click();
    await expect(page.locator('[data-node-id]').first()).toHaveCSS('--node-color', '#ff0a6c');

    await page.getByRole('button', { name: 'Tags and filter' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /^Color:/ }).click();
    await expect(dialog.getByRole('radio', { name: 'Navy' })).toBeVisible();
    await expectNoViolations(page);
    await dialog.getByRole('radio', { name: 'Navy' }).click();
    await dialog.getByLabel('New tag name').fill('work');
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(dialog.getByRole('button', { name: 'Tag color: Navy' })).toBeVisible();
  });
}

for (const theme of THEMES) {
  for (const width of [1280, 375] as const) {
    test(`AXE: notes panel, settings and anchored overlays in ${theme} at ${width}px`, async ({ page, browserName, isMobile }) => {
      test.skip(browserName !== 'chromium' || isMobile, 'viewport and overlay geometry are verified on desktop Chromium');
      await page.setViewportSize({ width, height: width === 375 ? 700 : 800 });
      await openIn(page, 'en', theme);
      await page.keyboard.press('n');
      const vp = (await page.locator('.bm-viewport').boundingBox())!;
      await page.mouse.click(vp.x + 100, vp.y + 160);
      await page.keyboard.type('Notes node');
      await page.keyboard.press('Escape');
      await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Notes and attachments' }).click();
      await expect(page.locator('bm-notes-panel')).toBeVisible();
      await expectNoViolations(page);
      await page.getByRole('button', { name: 'Close notes', exact: true }).click();
      await page.locator('[data-view-control="minimap"]').click();
      await expect(page.locator('bm-minimap')).toBeVisible();
      await expectNoViolations(page);
      await page.locator('[data-view-control="tags"]').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoViolations(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expectNoViolations(page);
    });
  }
}

for (const language of LANGUAGES) {
  for (const theme of THEMES) {
    test(`AXE: save toast, boards, export, login and tag popover in ${language} / ${theme}`, async ({ page, browserName, isMobile }) => {
      test.skip(browserName !== 'chromium' || isMobile, 'the surface sweep runs on desktop Chromium');
      await openIn(page, language, theme);
      await page.keyboard.press('n');
      const vp = (await page.locator('.bm-viewport').boundingBox())!;
      await page.mouse.click(vp.x + 160, vp.y + 160);
      await page.keyboard.type('Surface');
      await page.keyboard.press('Escape');
      await page.keyboard.press('ControlOrMeta+s');
      await expect(page.locator('.bm-toast')).toBeVisible();
      await expectNoViolations(page);
      await page.locator('button.bm-board-btn').click();
      await expect(page.locator('bm-board-switcher, [role="dialog"]').first()).toBeVisible();
      await expectNoViolations(page);
      await page.keyboard.press('Escape');

      await page.locator('[data-command="export.open"]').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoViolations(page);
      await page.keyboard.press('Escape');

      await page.locator('bm-account-actions button').first().click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoViolations(page);
      await page.keyboard.press('Escape');

      await page.locator('[data-view-control="tags"]').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoViolations(page);
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-view-control="tags"]')).toBeFocused();
    });
  }
}
