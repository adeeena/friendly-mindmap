import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'better-mindmap', 'browser');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
let version = 1;

createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://127.0.0.1:4311').pathname;
    response.setHeader('Cache-Control', 'no-store');
    if (path === '/__test/update') {
      version++;
      response.end('Updated');
      return;
    }
    if (path.startsWith('/api/')) {
      response.setHeader('Content-Type', 'application/json');
      response.statusCode = path === '/api/private-fixture' ? 200 : 401;
      response.end(JSON.stringify({ fixture: 'private-response-must-not-be-cached' }));
      return;
    }
    const file = join(root, ...decodeURIComponent(path).split('/').filter(Boolean));
    if (relative(root, file).startsWith('..')) { response.writeHead(403).end(); return; }
    if (path === '/ngsw.json') {
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      manifest.appData = { fixtureVersion: version };
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(manifest));
      return;
    }
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
    console.error(error);
    response.writeHead(500).end('Production fixture server failed');
  }
}).listen(4311, '127.0.0.1', () => console.log('Production fixture server ready'));
