import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { handleApi, initialAccount, normalizeAccount } from './engine.js';

const root = dirname(fileURLToPath(import.meta.url));
const assets = new Set(['index.html', 'styles.css', 'app.js', 'catalog.js', 'engine.js', 'store.js', 'sdk.js', 'sw.js', 'relay-mark.svg', 'site.json']);
const mime = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json', svg: 'image/svg+xml' };

export async function fileStore(file) {
  await mkdir(dirname(file), { recursive: true });
  let account;
  try { account = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; account = initialAccount(); }
  account = normalizeAccount(account);
  let pending = Promise.resolve();
  return {
    async read() { await pending; return { ...account }; },
    update(change) {
      const operation = pending.then(async () => {
        const result = change({ ...account });
        await writeFile(`${file}.tmp`, JSON.stringify(result.account), { mode: 0o600 });
        await rename(`${file}.tmp`, file);
        account = result.account;
        return result.response;
      });
      pending = operation.catch(() => {});
      return operation;
    },
  };
}

function authorized(header, key) {
  const supplied = Buffer.from(header || '');
  const expected = Buffer.from(`Bearer ${key}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createTomServer({ store, apiKey = 'sk-relay-demo', allowedOrigin = '', completionTiming }) {
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: { message: '请求地址无效。', type: 'invalid_request_error' } }));
      return;
    }
    if (url.pathname.startsWith('/v1/')) {
      res.setHeader('Cache-Control', 'no-store');
      if (allowedOrigin && req.headers.origin === allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (!authorized(req.headers.authorization, apiKey)) {
        res.writeHead(401); res.end(JSON.stringify({ error: { message: '缺少或无效的演示 API Key。', type: 'authentication_error' } })); return;
      }
      try {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 65536) { res.writeHead(413); res.end(JSON.stringify({ error: { message: '请求体不能超过 64 KiB。', type: 'invalid_request_error' } })); return; }
          chunks.push(chunk);
        }
        const request = new Request(url, { method: req.method, headers: { 'content-type': req.headers['content-type'] || '' }, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) });
        const response = await handleApi(request, url.pathname, store, completionTiming);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
      } catch { if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: { message: '请求处理失败。', type: 'server_error' } })); }
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const asset = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!assets.has(asset)) { res.writeHead(404); res.end('Not found'); return; }
    try {
      const content = await readFile(join(root, asset));
      res.writeHead(200, { 'Content-Type': mime[asset.split('.').at(-1)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8787);
  const store = await fileStore(process.env.DATA_FILE || join(root, '.data', 'account.json'));
  const server = createTomServer({ store, apiKey: process.env.API_KEY || 'sk-relay-demo', allowedOrigin: process.env.ALLOWED_ORIGIN || '' });
  server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Relay API listening on port ${port}. Browser and server ledgers are separate. No real funds.`));
}
