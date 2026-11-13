import { expect, test } from '@playwright/test';
import { addRoot, node, openApp, setToggle } from './helpers';

test('first launch creates "Untitled board" and an edit survives reload', async ({ page }) => {
  await openApp(page);
  await expect(page.getByRole('button', { name: /Current board: Untitled board/ })).toBeVisible();
  await addRoot(page, 200, 200, 'Persisted');
  await expect(page.locator('.bm-save-status[data-status="saved"]')).toBeAttached();
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(node(page, 'Persisted')).toBeVisible();
});

test('edits survive immediate real tab close without a debounce wait', async ({ page, context }) => {
  await openApp(page);
  await addRoot(page, 200, 200, 'Quick');
  await page.close();
  const second = await context.newPage();
  await second.goto('/');
  await expect(node(second, 'Quick')).toBeVisible();
});

test('journal restores edits after real close when IndexedDB writes fail', async ({ page, context }) => {
  await openApp(page);
  await page.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
      if (args[1] === 'readwrite') throw new DOMException('Interrupted local write', 'AbortError');
      return transaction.apply(this, args);
    };
  });
  await addRoot(page, 200, 200, 'Recovered draft');
  expect(await page.evaluate(() => Object.keys(localStorage).some((key) =>
    key.startsWith('better-mindmap-recovery:guest:') && localStorage.getItem(key)?.includes('Recovered draft')))).toBe(true);
  await page.close();
  const second = await context.newPage();
  await second.goto('/');
  await expect(node(second, 'Recovered draft')).toBeVisible();
  await expect.poll(() => second.evaluate(() => Object.keys(localStorage).filter((key) =>
    key.startsWith('better-mindmap-recovery:guest:')).length)).toBe(0);
});

test('boards keep their own content and layout settings', async ({ page }) => {
  await openApp(page);
  await addRoot(page, 200, 200, 'Work root');
  await page.getByRole('button', { name: 'Layout direction: horizontal' }).click();
  await page.getByRole('menuitemradio', { name: 'Vertical' }).click();

  await page.getByRole('button', { name: /^Open boards\./ }).click();
  const dialog = page.getByRole('dialog', { name: 'Boards' });
  await dialog.getByLabel('New board name').fill('Trip');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('button', { name: /Current board: Trip/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Layout direction: horizontal' })).toBeVisible();
  await addRoot(page, 200, 200, 'Trip root');

  await page.getByRole('button', { name: /^Open boards\./ }).click();
  await page.getByRole('dialog', { name: 'Boards' }).getByRole('button', { name: /^Untitled board/ }).click();
  await expect(node(page, 'Work root')).toBeVisible();
  await expect(node(page, 'Trip root')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Layout direction: vertical' })).toBeVisible();
});

test('deleting a board asks for confirmation', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /^Open boards\./ }).click();
  const dialog = page.getByRole('dialog', { name: 'Boards' });
  await dialog.getByLabel('New board name').fill('Temp');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: /^Open boards\./ }).click();
  await page.getByRole('button', { name: 'Delete Temp' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete board?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Delete Temp' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete Temp' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('button', { name: 'Delete Temp' })).toHaveCount(0);
});

test('a second tab picks up changes saved in the first', async ({ page, context }) => {
  await openApp(page);
  await setToggle(page, 'Snap to grid', true);
  const other = await context.newPage();
  await openApp(other);
  await addRoot(page, 200, 200, 'From tab one');
  await expect(node(other, 'From tab one')).toBeVisible({ timeout: 5000 });
});
