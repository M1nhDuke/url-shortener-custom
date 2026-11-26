// URL shortener, plain Node: node:http + node:sqlite, no dependencies.
// Same routes, table and rules as ../fastapi/main.py.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PORT = 3000;
const MAX_URL = 2048;
const MAX_EXPIRES_IN = 31_536_000; // 1 year, in seconds
const MAX_BODY = 16_384;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
// shortcut: printable ASCII only (what browsers copy from the address bar); to accept raw Unicode, percent-encode it before it goes in the Location header.
const URL_RE = /^https?:\/\/[!-~]+$/i;
const PAGE = readFileSync(join(import.meta.dirname, '../web/index.html'));

const db = new DatabaseSync(join(import.meta.dirname, 'links.db'));
db.exec(`CREATE TABLE IF NOT EXISTS links (
  code       TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  clicks     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER -- NULL = never expires
)`);
const insert = db.prepare('INSERT INTO links (code, url, created_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (code) DO NOTHING RETURNING *');
// SQLite's max() returns NULL if either side is NULL, and NULL means "never", so "never" beats any date.
const extend = db.prepare('UPDATE links SET expires_at = max(expires_at, ?) WHERE code = ? AND url = ? RETURNING *');
const find = db.prepare('SELECT * FROM links WHERE code = ?');
const click = db.prepare('UPDATE links SET clicks = clicks + 1 WHERE code = ? AND (expires_at IS NULL OR expires_at > ?) RETURNING url');

const now = () => Math.floor(Date.now() / 1000);

// SHA-256 -> big integer -> mod 62^7 -> 7 base62 characters.
function codeFor(text) {
  let n = BigInt('0x' + createHash('sha256').update(text).digest('hex')) % 62n ** 7n;
  let code = '';
  for (let i = 0; i < 7; i++) {
    code = ALPHABET[Number(n % 62n)] + code;
    n /= 62n;
  }
  return code;
}

// Same URL -> same code. If the code belongs to a different URL, try "1:url", "2:url", ...
// No race here: node:sqlite is synchronous and Node runs one request handler at a time.
function createLink(url, expiresAt) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = codeFor(attempt ? `${attempt}:${url}` : url);
    const created = insert.get(code, url, now(), expiresAt);
    if (created) return [201, created];
    const existing = extend.get(expiresAt, code, url);
    if (existing) return [200, existing];
  }
  throw new Error(`no free code for ${url} after 10 attempts`);
}

function parseNewLink(body) {
  const url = typeof body?.url === 'string' ? body.url.trim() : '';
  if (url.length > MAX_URL || !URL_RE.test(url)) {
    return { error: `url must be an http(s) URL of printable ASCII, at most ${MAX_URL} characters` };
  }
  const expiresIn = body.expires_in ?? null;
  if (expiresIn !== null && !(Number.isInteger(expiresIn) && expiresIn >= 1 && expiresIn <= MAX_EXPIRES_IN)) {
    return { error: `expires_in must be a whole number of seconds from 1 to ${MAX_EXPIRES_IN}` };
  }
  return { url, expiresAt: expiresIn === null ? null : now() + expiresIn };
}

async function readBody(req) {
  req.setEncoding('utf8');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error('body too large');
  }
  return body;
}

const send = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
const show = (req, row) => ({ ...row, short_url: `http://${req.headers.host ?? `localhost:${PORT}`}/${row.code}` });

async function handle(req, res) {
  const path = req.url.split('?')[0];

  if (req.method === 'GET' && path === '/') {
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
  }

  if (req.method === 'POST' && path === '/api/links') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: `body must be JSON, at most ${MAX_BODY} characters` });
    }
    const input = parseNewLink(body);
    if (input.error) return send(res, 400, { error: input.error });
    const [status, row] = createLink(input.url, input.expiresAt);
    return send(res, status, show(req, row));
  }

  const info = path.match(/^\/api\/links\/([^/]+)$/);
  if (req.method === 'GET' && info) {
    const row = find.get(info[1]);
    return row ? send(res, 200, show(req, row)) : send(res, 404, { error: 'link not found' });
  }

  const code = path.match(/^\/([^/]+)$/);
  if (req.method === 'GET' && code) {
    const row = click.get(code[1], now());
    if (row) return res.writeHead(302, { location: row.url }).end();
    return find.get(code[1]) ? send(res, 410, { error: 'link expired' }) : send(res, 404, { error: 'link not found' });
  }

  send(res, 404, { error: 'not found' });
}

createServer((req, res) =>
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
  }),
).listen(PORT, () => console.log(`Node version on http://localhost:${PORT}`));
