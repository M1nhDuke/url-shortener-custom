// One-off: find two URLs whose first-try codes clash, for the collision test in tests/links.test.js.
// Birthday paradox: with 62^7 (about 3.5 trillion) codes, a clash is expected after roughly 2.3 million URLs.
// Run: node scripts/find-collision.js
import { createHash } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Same algorithm as node/server.js; the tests fail if the two ever drift apart.
function codeFor(text) {
  let n = BigInt('0x' + createHash('sha256').update(text).digest('hex')) % 62n ** 7n;
  let code = '';
  for (let i = 0; i < 7; i++) {
    code = ALPHABET[Number(n % 62n)] + code;
    n /= 62n;
  }
  return code;
}

const seen = new Map(); // code -> URL
for (let i = 0; ; i++) {
  const url = `https://example.com/${i}`;
  const code = codeFor(url);
  if (seen.has(code)) {
    const first = seen.get(code);
    console.log({ first, second: url, sharedCode: code, secondRetryCode: codeFor(`1:${url}`), tried: i + 1 });
    break;
  }
  seen.set(code, url);
}
