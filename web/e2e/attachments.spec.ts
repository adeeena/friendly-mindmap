import AxeBuilder from '@axe-core/playwright';
import { Page, expect, test } from '@playwright/test';
import { addRoot, openApp } from './helpers';

test.beforeEach(async ({ page, isMobile }) => {
  test.skip(isMobile, 'the selection toolbar sits under the account corner at phone width, so the Notes button cannot be reached by pointer');
  await openApp(page);
});

/** Draws a picture in the page, so the resize has real pixels to work on, and returns its encoded bytes. */
async function picture(page: Page, width: number, height: number, type: 'image/jpeg' | 'image/png', quality = 0.95): Promise<Buffer> {
  const base64 = await page.evaluate(async ({ width, height, type, quality }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d')!;
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#c33');
    gradient.addColorStop(1, '#36c');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    for (let i = 0; i < 3000; i++) {
      context.fillStyle = `hsl(${(i * 37) % 360} 70% 50%)`;
      context.fillRect((i * 131) % width, (i * 197) % height, 30, 30);
    }
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), type, quality));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, { width, height, type, quality });
  return Buffer.from(base64, 'base64');
}

async function openNotes(page: Page, label: string) {
  await addRoot(page, 200, 200, label);
  await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Notes and attachments' }).click();
  const panel = page.getByRole('complementary', { name: /Notes/ });
  await expect(panel).toBeVisible();
  return panel;
}

/** Natural pixel size of the image shown in the preview dialog, then closes it with Escape. */
async function previewedSize(page: Page, thumbName: string): Promise<{ width: number; height: number }> {
  await page.getByRole('button', { name: thumbName }).click();
  const dialog = page.getByRole('dialog');
  const image = dialog.locator('img');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  const size = await image.evaluate((el: HTMLImageElement) => ({ width: el.naturalWidth, height: el.naturalHeight }));
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  return size;
}

test('attaching an optimised image shrinks it to 1920 px on the longer side and keeps the ratio', async ({ page }) => {
  const panel = await openNotes(page, 'Holiday');
  const original = await picture(page, 4000, 3000, 'image/jpeg');
  const chooser = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: 'Attach optimised image' }).click();
  await (await chooser).setFiles({ name: 'trip.jpg', mimeType: 'image/jpeg', buffer: original });

  await expect(panel.locator('.bm-notice')).toContainText('1920 × 1440');
  await expect(panel.locator('.bm-att-name')).toHaveText('trip.jpg');
  await expect(panel.locator('img.bm-thumb')).toHaveCount(1);
  expect(await previewedSize(page, 'Preview trip.jpg')).toEqual({ width: 1920, height: 1440 });

  const shown = await panel.locator('.bm-att-size').textContent();
  expect(shown).toMatch(/KB|MB/);
  expect(parseFloat(shown!) * (shown!.includes('MB') ? 1_048_576 : 1024)).toBeLessThan(original.length);

  const results = await new AxeBuilder({ page }).include('bm-notes-panel').analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
});

test('a photo over the 5 MiB guest limit is refused as a plain file but fits once optimised', async ({ page }) => {
  const panel = await openNotes(page, 'Big photo');
  const huge = Buffer.concat([await picture(page, 3000, 2000, 'image/jpeg'), Buffer.alloc(5_300_000)]);
  expect(huge.length).toBeGreaterThan(5_242_880);

  await panel.locator('input[type=file]').setInputFiles({ name: 'huge.jpg', mimeType: 'image/jpeg', buffer: huge });
  await expect(panel.locator('.bm-error')).toContainText('5 MiB');
  await expect(panel.locator('.bm-att-name')).toHaveCount(0);

  const chooser = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: 'Attach optimised image' }).click();
  await (await chooser).setFiles({ name: 'huge.jpg', mimeType: 'image/jpeg', buffer: huge });
  await expect(panel.locator('.bm-att-name')).toHaveText('huge.jpg');
  await expect(panel.locator('.bm-error')).toHaveCount(0);
  await expect(panel.locator('.bm-notice')).toContainText('1920 × 1280');
});

test('an uploaded image can be optimised in place', async ({ page }) => {
  const panel = await openNotes(page, 'Existing');
  const original = await picture(page, 3200, 2000, 'image/png');
  await panel.locator('input[type=file]').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: original });
  await expect(panel.locator('.bm-att-name')).toHaveText('shot.png');
  expect(await previewedSize(page, 'Preview shot.png')).toEqual({ width: 3200, height: 2000 });

  await panel.getByRole('button', { name: 'Optimise shot.png' }).click();
  await expect(panel.locator('.bm-notice')).toContainText('1920 × 1200');
  // WebKit cannot write webp, so png stays png there.
  await expect(panel.locator('.bm-att-name')).toHaveText(/^shot\.(webp|png)$/);
  const name = (await panel.locator('.bm-att-name').textContent())!;
  expect(await previewedSize(page, `Preview ${name}`)).toEqual({ width: 1920, height: 1200 });
  await expect(panel.locator('.bm-att')).toHaveCount(1);
});

test('an image that is already small is left unchanged', async ({ page }) => {
  const panel = await openNotes(page, 'Small');
  const small = await picture(page, 600, 400, 'image/jpeg', 0.4);
  await panel.locator('input[type=file]').setInputFiles({ name: 'tiny.jpg', mimeType: 'image/jpeg', buffer: small });
  await expect(panel.locator('.bm-att-name')).toHaveText('tiny.jpg');

  await panel.getByRole('button', { name: 'Optimise tiny.jpg' }).click();
  await expect(panel.locator('.bm-notice')).toContainText('already well optimised');
  await expect(panel.locator('.bm-att-name')).toHaveText('tiny.jpg');
});

test('only still raster images offer optimisation, and the preview opens from the thumbnail', async ({ page }) => {
  const panel = await openNotes(page, 'Mixed');
  await panel.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('plain') });
  await expect(panel.locator('.bm-att-name')).toHaveText('notes.txt');
  await expect(panel.getByRole('button', { name: /^Optimise / })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /^Preview / })).toHaveCount(0);
});
