// Black-box tests for both versions. Start a server first, then:
//   BASE_URL=http://localhost:3000 node --test tests/links.test.js   (Node)
//   BASE_URL=http://localhost:8000 node --test tests/links.test.js   (FastAPI)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';

// From scripts/find-collision.js: both URLs hash to the same first-try code.
const CLASH_FIRST = 'https://example.com/133976';
const CLASH_SECOND = 'https://example.com/1649738';
const CLASH_CODE = 'Uw4G3sp';
const CLASH_SECOND_RETRY = 'tu0lcQD'; // code for "1:" + CLASH_SECOND

// Links are deduplicated, so most tests need a URL no earlier run has used.
const fresh = () => `https://example.com/test/${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function create(body) {
  const res = await fetch(`${BASE}/api/links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function info(code) {
  const res = await fetch(`${BASE}/api/links/${code}`);
  return { status: res.status, body: await res.json() };
}
const follow = (code) => fetch(`${BASE}/${code}`, { redirect: 'manual' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('serves the page', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('creates a link with 201, then returns the same link with 200', async () => {
  const url = fresh();
  const first = await create({ url });
  assert.equal(first.status, 201);
  assert.match(first.body.code, /^[0-9a-zA-Z]{7}$/);
  assert.equal(first.body.url, url);
  assert.equal(first.body.clicks, 0);
  assert.equal(first.body.expires_at, null);
  assert.equal(typeof first.body.created_at, 'number');
  assert.equal(new URL(first.body.short_url).pathname, `/${first.body.code}`);

  const again = await create({ url: `  ${url}\n` }); // surrounding whitespace is trimmed
  assert.equal(again.status, 200);
  assert.equal(again.body.code, first.body.code);
});

test('redirects with 302 and counts clicks', async () => {
  const url = fresh();
  const { body } = await create({ url });
  for (let i = 0; i < 2; i++) {
    const res = await follow(body.code);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), url);
  }
  assert.equal((await info(body.code)).body.clicks, 2);
});

test('unknown codes are 404', async () => {
  const res = await follow('nope');
  assert.equal(res.status, 404);
  assert.equal(typeof (await res.json()).error, 'string');
  assert.equal((await info('nope')).status, 404);
});

test('rejects bad input with 400 and an error message', async () => {
  const prefix = `https://example.com/${Date.now()}/`;
  const tooLong = prefix + 'a'.repeat(2049 - prefix.length);
  const cases = [
    'not json',
    '[]',
    {},
    { url: 42 },
    { url: 'example.com' },
    { url: 'javascript:alert(1)' },
    { url: 'ftp://example.com/file' },
    { url: 'https://example.com/with space' },
    { url: tooLong },
    { url: fresh(), expires_in: 0 },
    { url: fresh(), expires_in: 1.5 },
    { url: fresh(), expires_in: '60' },
    { url: fresh(), expires_in: true },
    { url: fresh(), expires_in: 31_536_001 },
  ];
  for (const body of cases) {
    const res = await create(body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(typeof res.body.error, 'string');
  }
  const longest = await create({ url: tooLong.slice(0, 2048) });
  assert.equal(longest.status, 201, '2048 characters is allowed');
});

test('a known URL always gets the same code', async () => {
  const { status, body } = await create({ url: 'https://example.com' });
  assert.ok(status === 200 || status === 201);
  assert.equal(body.code, '6j2XRjj');
});

test('a hash collision moves the second URL to its retry code', async () => {
  assert.equal((await create({ url: CLASH_FIRST })).body.code, CLASH_CODE);
  assert.equal((await create({ url: CLASH_SECOND })).body.code, CLASH_SECOND_RETRY);
  assert.equal((await create({ url: CLASH_SECOND })).body.code, CLASH_SECOND_RETRY, 'dedupe follows the retry chain');
});

test('expired links are 410, keep their data, and come back when resubmitted', async () => {
  const url = fresh();
  const { body } = await create({ url, expires_in: 2 });
  assert.equal(body.expires_at, body.created_at + 2);
  assert.equal((await follow(body.code)).status, 302);

  await sleep(2100);
  const gone = await follow(body.code);
  assert.equal(gone.status, 410);
  assert.equal(typeof (await gone.json()).error, 'string');
  assert.equal((await info(body.code)).body.clicks, 1, 'visits to an expired link are not counted');

  const revived = await create({ url });
  assert.equal(revived.status, 200);
  assert.equal(revived.body.expires_at, null);
  assert.equal((await follow(body.code)).status, 302);
  assert.equal((await info(body.code)).body.clicks, 2);
});

test('resubmitting keeps the later expiry, and "never" wins', async () => {
  const url = fresh();
  const short = (await create({ url, expires_in: 60 })).body.expires_at;
  const long = (await create({ url, expires_in: 3600 })).body.expires_at;
  assert.ok(long > short);
  assert.equal((await create({ url, expires_in: 60 })).body.expires_at, long, 'a shorter expiry does not cut a link short');
  assert.equal((await create({ url })).body.expires_at, null);
  assert.equal((await create({ url, expires_in: 60 })).body.expires_at, null);
});
