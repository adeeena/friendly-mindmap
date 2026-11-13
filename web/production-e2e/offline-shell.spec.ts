import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { addRoot, node, openApp } from '../e2e/helpers';

test('production shell restores offline account edits, excludes private responses, and preserves the outbox through an update', async ({ page, context, request }) => {
  const account = {
    account: { id: randomUUID(), username: 'test', display_name: 'Offline Admin', role: 'admin' },
    sessionId: randomUUID(), csrfToken: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z',
  };
  let signedIn = false;
  let offlineMode = false;
  await context.route(/\/api\/boards\/[^/?]+$/, (route) => route.abort('internetdisconnected'));
  await context.route(/\/api\/boards\?includeDeleted=true$/, (route) => offlineMode ? route.abort('internetdisconnected') : route.fulfill({ json: [] }));
  await context.route('**/api/auth/session', (route) => offlineMode ? route.abort('internetdisconnected') : route.fulfill(signedIn
    ? { json: account } : { status: 401, json: {} }));
  await context.route('**/api/auth/login', async (route) => {
    signedIn = true;
    await route.fulfill({ json: account });
  });
  await openApp(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Log in' });
  await dialog.getByLabel('Username', { exact: true }).fill('test');
  await dialog.getByLabel('Password', { exact: true }).fill('test-only-password');
  await dialog.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByText('Offline Admin', { exact: true })).toBeVisible();
  await addRoot(page, 200, 200, 'Queued account work');
  await page.evaluate(async () => {
    await fetch('/api/private-fixture');
    const keys = await caches.keys();
    for (const key of keys) {
      const cache = await caches.open(key);
      if ((await cache.keys()).some((entry) => new URL(entry.url).pathname.startsWith('/api/'))) {
        throw new Error('Private API response was cached by the service worker');
      }
    }
  });
  offlineMode = true;
  await context.setOffline(true);
  await page.close();
  const offline = await context.newPage();
  await offline.goto('/');
  await expect(node(offline, 'Queued account work')).toBeVisible();
  await expect(offline.getByText('Offline account cache. Log in to verify your account before cloud synchronization.', { exact: true })).toBeVisible();
  await addRoot(offline, 360, 260, 'Added offline');
  offlineMode = false;
  await context.setOffline(false);
  await request.get('/__test/update');
  await offline.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(offline.getByText('An application update is ready. Save local work and reload to update.', { exact: true })).toBeVisible();
  await offline.getByRole('button', { name: 'Save and reload' }).click();
  await expect(node(offline, 'Queued account work')).toBeVisible();
  await expect(node(offline, 'Added offline')).toBeVisible();
  expect(await offline.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('better-mindmap-account-' + id);
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const count = await new Promise<number>((resolve, reject) => {
      const reading = db.transaction('outbox').objectStore('outbox').count();
      reading.onsuccess = () => resolve(reading.result);
      reading.onerror = () => reject(reading.error);
    });
    db.close();
    return count;
  }, account.account.id)).toBeGreaterThan(0);
});
