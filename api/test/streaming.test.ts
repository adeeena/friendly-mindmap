import assert from 'node:assert/strict';
import { ChildProcess, fork } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { test } from 'node:test';
import { hashPassword } from '../src/credentials';
import { migrate, readMigrations } from '../src/migrations';
import { isolatedPostgres } from './postgres';
import { isolatedStorage } from './storage';

async function message(child: ChildProcess): Promise<Record<string, unknown>> {
  const [value] = await once(child, 'message', { signal: AbortSignal.timeout(30_000) });
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test('256 MiB transfer through real HTTP keeps isolated API memory bounded', { timeout: 300_000 }, async (t) => {
  const database = await isolatedPostgres();
  let objectStore: Awaited<ReturnType<typeof isolatedStorage>> | undefined;
  let child: ChildProcess | undefined;
  try {
    objectStore = await isolatedStorage();
    await migrate(database.pool, await readMigrations());
    const owner = randomUUID();
    const board = randomUUID();
    const password = randomBytes(16).toString('hex');
    await database.pool.query(`INSERT INTO users(id,username,display_name,password_hash,role)
      VALUES ($1,'admin','Admin',$2,'admin')`, [owner, await hashPassword(password)]);
    await database.pool.query(`INSERT INTO boards(id,owner_id,name,content,schema_version,content_hash)
      VALUES ($1,$2,'Memory test','{}',2,'hash')`, [board, owner]);
    const config = objectStore.storage.config;
    child = fork(join(__dirname, 'stream-server.js'), [], {
      silent: true,
      env: {
        ...process.env, DATABASE_URL: database.connectionString, APP_ORIGIN: 'http://127.0.0.1:6610',
        NODE_ENV: 'development', S3_ENDPOINT: config.endpoint, S3_BUCKET: config.bucket, S3_REGION: config.region,
        S3_ACCESS_KEY: config.accessKeyId, S3_SECRET_KEY: config.secretAccessKey,
      },
    });
    const ready = await message(child);
    assert.equal(ready['type'], 'ready', JSON.stringify(ready));
    const address = String(ready['address']);
    const login = await fetch(`${address}/api/auth/login`, {
      method: 'POST', headers: { origin: 'http://127.0.0.1:6610', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password }),
    });
    assert.equal(login.status, 200);
    const authenticated = await login.json() as { csrfToken: string };
    const headers = {
      origin: 'http://127.0.0.1:6610', cookie: login.headers.getSetCookie()[0]!.split(';')[0]!,
      'x-csrf-token': authenticated.csrfToken,
    };
    const url = `${address}/api/boards/${board}/uploads/${randomUUID()}`;
    const size = 256 * 1024 * 1024;
    const initiated = await fetch(url, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node', name: 'large.bin', mime: 'application/octet-stream', size }),
    });
    assert.equal(initiated.status, 200);
    const info = await initiated.json() as { partSize: number };
    const measuring = message(child);
    child.send('measure');
    assert.equal((await measuring)['type'], 'measuring');
    const chunk = Buffer.alloc(64 * 1024, 37);
    const hash = createHash('sha256');
    for (let number = 1; number <= size / info.partSize; number++) {
      const req = request(`${url}/parts/${number}`, {
        method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': String(info.partSize) },
      });
      const acknowledged = new Promise<number>((resolve, reject) => {
        req.on('error', reject);
        req.on('response', (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); res.on('error', reject); });
      });
      async function* chunks() {
        for (let offset = 0; offset < info.partSize; offset += chunk.length) {
          hash.update(chunk);
          yield chunk;
        }
      }
      const [, status] = await Promise.all([
        pipeline(Readable.from(chunks(), { objectMode: false, highWaterMark: chunk.length }), req), acknowledged,
      ]);
      assert.equal(status, 200);
    }
    const finalized = await fetch(`${url}/complete`, { method: 'POST', headers });
    assert.equal(finalized.status, 200);
    const completed = await finalized.json() as { attachment: { size: number; checksum: string } };
    assert.equal(completed.attachment.size, size);
    assert.equal(completed.attachment.checksum, hash.digest('hex'));
    const reporting = message(child);
    child.send('report');
    const usage = await reporting;
    assert.equal(usage['type'], 'report');
    assert(typeof usage['rssGrowth'] === 'number' && usage['rssGrowth'] < 128 * 1024 * 1024, JSON.stringify(usage));
    assert(typeof usage['externalGrowth'] === 'number' && usage['externalGrowth'] < 64 * 1024 * 1024, JSON.stringify(usage));
    t.diagnostic(JSON.stringify({ fileBytes: size, partBytes: info.partSize, ...usage }));
  } finally {
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit', { signal: AbortSignal.timeout(30_000) });
        if (child.connected) child.send('shutdown'); else child.kill();
        try { await exited; } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
      }
    } finally {
      try { await objectStore?.close(); } finally { await database.close(); }
    }
  }
});
