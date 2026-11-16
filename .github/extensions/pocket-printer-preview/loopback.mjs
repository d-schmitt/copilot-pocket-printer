import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PreviewError } from './png.mjs';

export async function readBody(req, limit, contentType) {
  if (req.headers['content-type'] !== contentType) {
    throw new PreviewError('invalid_request', `Expected ${contentType}.`);
  }
  if (Number(req.headers['content-length']) > limit) {
    throw new PreviewError('request_too_large', `Request exceeds ${limit} bytes.`);
  }
  const chunks = [];
  let length = 0;
  const timer = setTimeout(() => req.destroy(), 10_000);
  try {
    for await (const chunk of req) {
      length += chunk.length;
      if (length > limit) throw new PreviewError('request_too_large', `Request exceeds ${limit} bytes.`);
      chunks.push(chunk);
    }
  } finally { clearTimeout(timer); }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  const bytes = await readBody(req, 64 * 1024, 'application/json');
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new PreviewError('invalid_request', 'Request must be valid JSON.'); }
}

export async function servePanel({ assets, get, post, onError }) {
  const files = new Map(await Promise.all(Object.entries(assets).map(async ([route, [file, type]]) =>
    [route, { body: await readFile(new URL(file, import.meta.url)), type }])));
  const prefix = `/${randomBytes(32).toString('hex')}/`;
  let origin;
  const server = createServer((req, res) => {
    void respond(req, res).catch(error => {
      const failure = onError(error);
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: failure }));
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 16;
  async function respond(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'");
    if (req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin)) {
      res.writeHead(403); res.end('Forbidden.'); return;
    }
    const url = new URL(req.url, origin);
    if (!url.pathname.startsWith(prefix)) { res.writeHead(404); res.end('Not found.'); return; }
    const route = url.pathname.slice(prefix.length);
    let response;
    if (req.method === 'GET') {
      response = files.get(route) ?? await get(route, url.searchParams);
      if (!response) { res.writeHead(404); res.end('Not found.'); return; }
    } else {
      if (req.method !== 'POST' || !Object.hasOwn(post, route)) {
        res.writeHead(405); res.end('Method not allowed.'); return;
      }
      if (req.headers.origin !== origin) { res.writeHead(403); res.end('Forbidden.'); return; }
      response = { type: 'application/json', body: JSON.stringify(await post[route](req)) };
    }
    res.setHeader('Content-Type', response.type);
    res.end(response.body);
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: origin + prefix,
    close: () => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    })
  };
}
