import { Page, expect, test } from '@playwright/test';
import { MOD, addRoot, node, nodes, openApp, rect } from './helpers';

test.beforeEach(async ({ page }) => openApp(page));

const SETTINGS_KEY = 'friendly-mindmap.settings';

/** Parent -> Child (created with Tab), parent at the top-left of the canvas. */
async function parentWithChild(page: Page): Promise<void> {
  await addRoot(page, 120, 120, 'Parent');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Child');
  await page.keyboard.press('Escape');
  await expect(node(page, 'Child')).toBeFocused();
}

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(1200);
}

async function rightClickCenter(page: Page, selector: string): Promise<void> {
  const box = (await page.locator(selector).first().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
}

test.describe('quick emoji', () => {
  test('one click sets and removes an emoji; picked emojis join the list and persist', async ({ page, isMobile }) => {
    test.skip(isMobile, 'mouse click');
    await addRoot(page, 200, 220, 'Task');
    const bar = page.getByRole('toolbar', { name: 'Quick emoji' });
    await expect(bar.locator('.bm-emoji-btn')).toHaveText(['🚩', '✅', '⚠️', '📞', '❌', '🐞', '⌛', '🔄']);

    await bar.getByRole('button', { name: '🚩' }).click();
    await expect(node(page, 'Task')).toContainText('🚩');
    await bar.getByRole('button', { name: '🚩' }).click();
    await expect(node(page, 'Task')).not.toContainText('🚩');

    await bar.getByRole('button', { name: 'More emoji…' }).click();
    const picker = page.getByRole('dialog', { name: 'Emoji picker' });
    await expect(picker.getByRole('heading')).toHaveCount(8);
    await picker.getByRole('button', { name: '🎉' }).click();
    await expect(picker).toHaveCount(0);
    await expect(node(page, 'Task')).toContainText('🎉');
    await expect(bar.locator('.bm-emoji-btn').last()).toHaveText('🎉');

    await bar.getByRole('button', { name: 'More emoji…' }).click();
    await picker.getByLabel('Type or paste an emoji').fill('🦄');
    await page.keyboard.press('Enter');
    await expect(bar.locator('.bm-emoji-btn')).toHaveText(['🚩', '✅', '⚠️', '📞', '❌', '🐞', '⌛', '🔄', '🎉', '🦄']);

    await settle(page);
    await page.reload();
    await node(page, 'Task').click();
    await expect(bar.locator('.bm-emoji-btn')).toHaveText(['🚩', '✅', '⚠️', '📞', '❌', '🐞', '⌛', '🔄', '🎉', '🦄']);
  });

  test('the picker rejects text and closes with Escape', async ({ page, isMobile }) => {
    test.skip(isMobile, 'mouse click');
    await addRoot(page, 200, 220, 'Task');
    await page.getByRole('toolbar', { name: 'Quick emoji' }).getByRole('button', { name: 'More emoji…' }).click();
    const picker = page.getByRole('dialog', { name: 'Emoji picker' });
    const input = picker.getByLabel('Type or paste an emoji');
    await input.fill('hello');
    await input.press('Enter');
    await expect(picker.getByRole('alert')).toHaveText('Enter a single emoji.');
    await input.press('Escape');
    await expect(picker).toHaveCount(0);
  });
});

test.describe('child drag keeps the connection', () => {
  test('dropping on empty canvas keeps the parent link and a manual offset, also after reload', async ({ page, isMobile }) => {
    test.skip(isMobile, 'mouse drag');
    await parentWithChild(page);
    await expect(page.locator('.bm-edge')).toHaveCount(1);
    const before = await rect(page, 'Child');
    const vp = (await page.locator('.bm-viewport').boundingBox())!;
    const target = { x: vp.x + 640, y: vp.y + 460 };
    await page.mouse.move(before.x + 8, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 10 });
    await page.mouse.up();

    await expect(node(page, 'Child')).toHaveAttribute('aria-level', '2');
    await expect(page.locator('.bm-edge')).toHaveCount(1);
    const after = await rect(page, 'Child');
    expect(Math.abs(after.x - before.x - (target.x - before.x - 8))).toBeLessThan(16);
    expect(after.y - before.y).toBeGreaterThan(200);

    await settle(page);
    await page.reload();
    await expect(node(page, 'Child')).toHaveAttribute('aria-level', '2');
    await expect(page.locator('.bm-edge')).toHaveCount(1);
    const reloaded = await rect(page, 'Child');
    expect(Math.abs(reloaded.y - after.y)).toBeLessThan(2);
  });

  test('promoting to a root stays explicit', async ({ page }) => {
    await parentWithChild(page);
    await page.keyboard.press('Shift+Tab');
    await expect(node(page, 'Child')).toHaveAttribute('aria-level', '1');
    await expect(page.locator('.bm-edge')).toHaveCount(0);
  });
});

test.describe('line style', () => {
  test('hierarchy edges and cross-links share the same solid default', async ({ page, isMobile }) => {
    test.skip(isMobile, 'mouse drag');
    await parentWithChild(page);
    await addRoot(page, 120, 380, 'Other');
    await page.getByRole('button', { name: 'New connection', exact: true }).click();
    const a = await rect(page, 'Parent');
    const b = await rect(page, 'Other');
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up();
    const hier = page.locator('.bm-edge');
    const link = page.locator('.bm-link:not(.preview)');
    await expect(hier).toHaveCount(1);
    await expect(link).toHaveCount(1);
    for (const edge of [hier, link]) {
      await expect(edge).toHaveCSS('fill', 'none');
      await expect(edge).toHaveCSS('stroke-width', '2px');
      await expect(edge).toHaveCSS('stroke-dasharray', 'none');
    }
  });

  test('the line context menu styles only that edge and the style persists', async ({ page, isMobile }) => {
    test.skip(isMobile, 'mouse right-click');
    await parentWithChild(page);
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Second');
    await page.keyboard.press('Escape');
    await expect(page.locator('.bm-edge')).toHaveCount(2);

    const child = page.locator('.bm-edge').first();
    await rightClickCenter(page, '[data-edge^="h:"]');
    const menu = page.getByRole('menu', { name: 'Line style' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitemradio', { name: 'Dashed' }).click();
    await menu.getByRole('menuitemradio', { name: 'Rose' }).click();
    await menu.getByRole('menuitemradio', { name: '4 px' }).click();
    await expect(child).toHaveCSS('stroke-width', '5px');
    await expect(child).toHaveCSS('stroke-dasharray', '20px, 15px');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    await expect(page.locator('.bm-edge').nth(1)).toHaveCSS('stroke-width', '2px');
    await expect(page.locator('.bm-edge').nth(1)).toHaveCSS('stroke-dasharray', 'none');

    await settle(page);
    await page.reload();
    await expect(page.locator('.bm-edge').first()).toHaveCSS('stroke-dasharray', '16px, 12px');
    await expect(page.locator('.bm-edge').first()).toHaveCSS('stroke-width', '4px');
  });

  test('reset returns an edge to the default', async ({ page, isMobile }) => {
    test.skip(isMobile, 'mouse right-click');
    await parentWithChild(page);
    await rightClickCenter(page, '[data-edge^="h:"]');
    const menu = page.getByRole('menu', { name: 'Line style' });
    await menu.getByRole('menuitemradio', { name: 'Dotted' }).click();
    await expect(page.locator('.bm-edge')).not.toHaveCSS('stroke-dasharray', 'none');
    await menu.getByRole('menuitem', { name: 'Reset line style' }).click();
    await expect(page.locator('.bm-edge')).toHaveCSS('stroke-dasharray', 'none');
  });
});

test.describe('board rename', () => {
  test('Save and Load are in the boards dialog, not the toolbar', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Save to file' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Load from file' })).toHaveCount(0);

    await page.getByRole('button', { name: /^Boards\./ }).click();
    const dialog = page.getByRole('dialog', { name: 'Boards' });
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Save to file' }).click();
    expect((await download).suggestedFilename()).toMatch(/\.bmm\.json$/);
    await expect(dialog).toHaveCount(0);

    await page.getByRole('button', { name: /^Boards\./ }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('dialog', { name: 'Boards' }).getByRole('button', { name: 'Load from file' }).click();
    expect(await chooser).toBeTruthy();
  });

  test('rename from the boards list updates the name in place', async ({ page }) => {
    await page.getByRole('button', { name: /^Boards\./ }).click();
    const dialog = page.getByRole('dialog', { name: 'Boards' });
    await dialog.getByRole('button', { name: 'Rename Untitled board' }).click();
    const field = dialog.getByRole('textbox', { name: 'Board name', exact: true });
    await expect(field).toBeFocused();
    await field.fill('Roadmap');
    await field.press('Enter');
    await expect(dialog.getByRole('listitem')).toHaveCount(1);
    await expect(dialog.getByRole('button', { name: /^Roadmap/ })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('button', { name: /Current board: Roadmap/ })).toBeVisible();
  });

  test('cancel button leaves the name unchanged', async ({ page }) => {
    await page.getByRole('button', { name: /^Boards\./ }).click();
    const dialog = page.getByRole('dialog', { name: 'Boards' });
    await dialog.getByRole('button', { name: 'Rename Untitled board' }).click();
    await dialog.getByRole('textbox', { name: 'Board name', exact: true }).fill('Nope');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog.getByRole('button', { name: /^Untitled board/ })).toBeVisible();
  });

  test('renames the current board in place without adding a board', async ({ page }) => {
    await page.getByRole('button', { name: 'Rename board' }).click();
    const field = page.getByRole('textbox', { name: 'Board name' });
    await expect(field).toBeFocused();
    await field.fill('Plans');
    await field.press('Enter');
    await expect(page.getByRole('button', { name: /Current board: Plans/ })).toBeVisible();

    await page.getByRole('button', { name: /^Boards\./ }).click();
    const dialog = page.getByRole('dialog', { name: 'Boards' });
    await expect(dialog.getByRole('listitem')).toHaveCount(1);
    await expect(dialog.getByRole('listitem')).toContainText('Plans');
    await page.keyboard.press('Escape');

    await page.reload();
    await expect(page.getByRole('button', { name: /Current board: Plans/ })).toBeVisible();
  });

  test('Escape discards the edit', async ({ page }) => {
    await page.getByRole('button', { name: 'Rename board' }).click();
    const field = page.getByRole('textbox', { name: 'Board name' });
    await field.fill('Nope');
    await field.press('Escape');
    await expect(page.getByRole('button', { name: /Current board: Untitled board/ })).toBeVisible();
  });
});

test.describe('settings', () => {
  const openSettings = async (page: Page) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.locator('bm-settings-dialog');
    await expect(dialog).toBeVisible();
    return dialog;
  };

  test('has Appearance and Language tabs, the version, and a Made by link to adena.dev', async ({ page }) => {
    const dialog = await openSettings(page);
    await expect(dialog.getByRole('tab')).toHaveText(['Appearance', 'Language']);
    await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Appearance');
    await expect(dialog.getByText(/^Version \d+\.\d+\.\d+/)).toBeVisible();
    const footer = dialog.locator('.bm-set-footer');
    await expect(footer).toContainText('Made by');
    const link = footer.getByRole('link', { name: 'Muráncsik Adéna Auróra' });
    await expect(link).toHaveAttribute('href', 'https://adena.dev');
    await expect(link).toHaveAttribute('target', '_blank');
  });

  test('theme choice overrides the OS and survives reload; System follows the OS', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const dialog = await openSettings(page);
    await dialog.getByRole('radio', { name: 'Light mode' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    const again = await openSettings(page);
    await again.getByRole('radio', { name: 'Sync with device' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('language switches the whole interface and is remembered', async ({ page }) => {
    const dialog = await openSettings(page);
    await dialog.getByRole('tab', { name: 'Language' }).click();
    await dialog.getByRole('radio', { name: 'Français' }).check();
    await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Langue');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await dialog.getByRole('button', { name: 'Fermer' }).click();
    await expect(page.getByRole('button', { name: 'Annuler', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Renommer le tableau' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Tableaux\. Tableau actuel/ })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('button', { name: 'Paramètres', exact: true })).toBeVisible();
    const stored = await page.evaluate((k) => localStorage.getItem(k), SETTINGS_KEY);
    expect(JSON.parse(stored!)).toMatchObject({ language: 'fr' });

    await page.getByRole('button', { name: 'Paramètres', exact: true }).click();
    await page.getByRole('tab', { name: 'Langue' }).click();
    await page.getByRole('radio', { name: 'Magyar' }).check();
    await expect(page.locator('bm-settings-dialog').getByRole('heading', { level: 2 })).toHaveText('Nyelv');
    await page.getByRole('button', { name: 'Bezárás' }).click();
    await expect(page.getByRole('button', { name: 'Visszavonás', exact: true })).toBeVisible();
  });

  test('palette, selection toolbar and line menu follow the language', async ({ page, isMobile }) => {
    test.skip(isMobile, 'mouse right-click');
    await parentWithChild(page);
    const dialog = await openSettings(page);
    await dialog.getByRole('tab', { name: 'Language' }).click();
    await dialog.getByRole('radio', { name: 'Français' }).check();
    await dialog.getByRole('button', { name: 'Fermer' }).click();
    await page.keyboard.press(`${MOD}+k`);
    const palette = page.getByRole('combobox');
    await expect(palette).toHaveAttribute('placeholder', 'Saisissez une commande…');
    await palette.fill('renommer');
    await expect(page.getByRole('option', { name: /Renommer le tableau/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await page.keyboard.press('Escape');
    await node(page, 'Parent').click();
    await expect(page.getByRole('toolbar', { name: 'Sélection' })).toBeVisible();
    // Selected nodes show "+" handles next to the edge, so deselect before opening the line menu.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('toolbar', { name: 'Sélection' })).toBeHidden();
    await rightClickCenter(page, '[data-edge^="h:"]');
    await expect(page.getByRole('menu', { name: 'Style de ligne' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(nodes(page)).toHaveCount(2);
  });
});
