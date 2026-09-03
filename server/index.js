import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { LobbyManager } from './LobbyManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 8787;

/**
 * Apex Circuit race server.
 *
 * Serves the built client when one exists (so `npm run build && npm start`
 * gives a single deployable process), and hosts the authoritative race
 * sessions over a WebSocket at /ws.
 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
};

const DIST = path.join(ROOT, 'dist');
const hasBuild = fs.existsSync(path.join(DIST, 'index.html'));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(lobbies.health()));
    return;
  }

  if (!hasBuild) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<h1>Apex Circuit race server</h1>' +
      `<p>WebSocket listening on <code>ws://localhost:${PORT}/ws</code>.</p>` +
      '<p>No client build found. Run <code>npm run dev</code> for the dev ' +
      'server, or <code>npm run build</code> to have this process serve the ' +
      'game directly.</p>'
    );
    return;
  }

  // Static file serving, confined to dist/.
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel.endsWith('/')) rel += 'index.html';
  const filePath = path.join(DIST, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Single-page app fallback.
      fs.readFile(path.join(DIST, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });
const lobbies = new LobbyManager();

wss.on('connection', (socket, req) => {
  lobbies.handleConnection(socket, req);
});

server.listen(PORT, () => {
  console.log(`[apex] race server on http://localhost:${PORT}`);
  console.log(`[apex] websocket at ws://localhost:${PORT}/ws`);
  if (!hasBuild) console.log('[apex] no dist/ build; run `npm run dev` for the client');
});

function shutdown() {
  console.log('\n[apex] shutting down');
  lobbies.shutdown();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
