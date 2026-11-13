const { createServer, request: proxyRequest } = require('node:http');
const { randomBytes, randomUUID } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { extname, join, relative, resolve } = require('node:path');
const { isolatedPostgres } = require('../../api/dist/api/test/postgres.js');
const { isolatedStorage } = require('../../api/dist/api/test/storage.js');
const { buildApp } = require('../../api/dist/api/src/app.js');
const { hashPassword } = require('../../api/dist/api/src/credentials.js');
const { migrate, readMigrations } = require('../../api/dist/api/src/migrations.js');
const { safeDiagnostic } = require('../../api/dist/api/src/errors.js');

const root = resolve(__dirname, '..', 'dist', 'better-mindmap', 'browser');
const origin = 'http://127.0.0.1:4312';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const credentials = { username: 'sync-fixture', password: randomBytes(24).toString('hex') };
const secondCredentials = { username: 'second-fixture', password: randomBytes(24).toString('hex') };
let database, objects, app, server, closing;
const controls = { loseNextCommit: false, loseNextPart: false, holdNextLogout: false };
const metrics = { lostCommits: 0, lostParts: 0, parts: {}, heldLogouts: 0, logoutCookies: 0 };
let releaseLogout;

function cleanup() {
  closing ??= (async () => {
    try { await app?.close(); }
    finally { try { await objects?.close(); } finally { await database?.close(); } }
  })();
  return closing;
}

async function main() {
  database = await isolatedPostgres();
  objects = await isolatedStorage();
  const migrations = await readMigrations();
  await migrate(database.pool, migrations);
  await database.pool.query(`INSERT INTO users(id,username,display_name,password_hash,role)
    VALUES ($1,$2,'Sync Fixture',$3,'admin')`, [randomUUID(), credentials.username, await hashPassword(credentials.password)]);
  await database.pool.query(`INSERT INTO users(id,username,display_name,password_hash,role)
    VALUES ($1,$2,'Second Fixture',$3,'basic')`, [randomUUID(), secondCredentials.username, await hashPassword(secondCredentials.password)]);
  app = buildApp(database.pool, migrations, { logger: false }, { origin, secure: false }, objects.storage);
  const apiAddress = await app.listen({ host: '127.0.0.1', port: 0 });
  server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, origin).pathname;
      response.setHeader('Cache-Control', 'no-store');
      if (path === '/__test/shutdown' && request.method === 'POST') {
        await cleanup();
        response.end('Fixture containers removed');
        server.close();
        return;
      }
      if (path === '/__test/credentials') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(new URL(request.url, origin).searchParams.get('who') === 'second' ? secondCredentials : credentials));
        return;
      }
      if (path === '/__test/control' && request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const value = JSON.parse(Buffer.concat(chunks).toString());
        if (value.expireSessions === true) await database.pool.query("UPDATE sessions SET idle_expires_at=now()-interval '1 minute'");
        if (value.resetLoginThrottle === true) await database.pool.query('DELETE FROM login_attempts');
        if (value.resetConfigurations === true) await database.pool.query("UPDATE users SET configuration='{}', configuration_revision=0");
        if (value.releaseLogout === true) {
          const release = releaseLogout;
          releaseLogout = undefined;
          release?.();
        }
        for (const key of Object.keys(controls)) if (typeof value[key] === 'boolean') controls[key] = value[key];
        response.end('Configured');
        return;
      }
      if (path === '/__test/state') {
        const boards = await database.pool.query(`SELECT b.id,b.name,b.revision,b.content,b.deleted_at,b.is_staged,u.username AS owner_username
          FROM boards b JOIN users u ON u.id=b.owner_id ORDER BY b.created_at`);
        const history = await database.pool.query('SELECT board_id,content_revision FROM board_history ORDER BY content_revision');
        const files = await database.pool.query('SELECT id,board_id,size_bytes,state,checksum FROM board_attachments');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ boards: boards.rows, history: history.rows, files: files.rows, metrics }));
        return;
      }
      if (path.startsWith('/api/')) {
        const isPart = request.method === 'PUT' && /\/uploads\/[^/]+\/parts\/\d+$/.test(path);
        const isCommit = request.method === 'PUT' && /^\/api\/boards\/[^/]+$/.test(path);
        if (isPart) metrics.parts[path] = (metrics.parts[path] ?? 0) + 1;
        const forwarded = proxyRequest(new URL(request.url, apiAddress), {
          method: request.method, headers: request.headers,
        }, (upstream) => {
          if (path === '/api/auth/logout' && upstream.statusCode === 204 && controls.holdNextLogout) {
            controls.holdNextLogout = false;
            metrics.heldLogouts++;
            metrics.logoutCookies += upstream.headers['set-cookie']?.length ?? 0;
            upstream.resume();
            releaseLogout = () => { response.writeHead(204, upstream.headers); response.end(); };
            return;
          }
          if (upstream.statusCode === 200 && ((isCommit && controls.loseNextCommit) || (isPart && controls.loseNextPart))) {
            if (isCommit) { controls.loseNextCommit = false; metrics.lostCommits++; }
            if (isPart) { controls.loseNextPart = false; metrics.lostParts++; }
            upstream.resume();
            upstream.on('end', () => {
              // A partial acknowledgement avoids Chromium transparently retrying a headerless PUT.
              response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '4096' });
              response.write('{"interrupted":', () => response.destroy());
            });
            return;
          }
          response.writeHead(upstream.statusCode, upstream.headers);
          upstream.pipe(response);
          upstream.on('error', () => response.destroy());
        });
        forwarded.on('error', () => response.destroy());
        request.pipe(forwarded);
        return;
      }
      const file = join(root, ...decodeURIComponent(path).split('/').filter(Boolean));
      if (relative(root, file).startsWith('..')) { response.writeHead(403).end(); return; }
      let data;
      let type = types[extname(file)] ?? 'application/octet-stream';
      try { data = await readFile(file); }
      catch (error) {
        if (!['ENOENT', 'EISDIR'].includes(error.code)) throw error;
        if (extname(file)) { response.writeHead(404).end(); return; }
        data = await readFile(join(root, 'index.html'));
        type = 'text/html';
      }
      response.setHeader('Content-Type', type);
      response.end(data);
    } catch (error) {
      console.error('Cloud fixture request failed', safeDiagnostic(error));
      response.writeHead(500).end('Cloud fixture failed');
    }
  });
  server.listen(4312, '127.0.0.1', () => console.log('Isolated cloud fixture ready'));
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  void cleanup().then(() => server?.close()).catch((error) => {
    console.error('Cloud fixture cleanup failed', safeDiagnostic(error));
    process.exitCode = 1;
  });
});
void main().catch(async (error) => {
  console.error('Cloud fixture startup failed', safeDiagnostic(error));
  try { await cleanup(); } finally { process.exitCode = 1; }
});
