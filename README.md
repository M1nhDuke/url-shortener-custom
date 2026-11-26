# URL shortener, built twice

The same URL shortener in **plain Node 26** (`node:http` + `node:sqlite`, no dependencies) and in **FastAPI**. One black-box test suite checks that both behave the same.

```
web/index.html            the page both versions serve
node/server.js            Node version, port 3000, stores links in node/links.db
fastapi/main.py           FastAPI version, port 8000, stores links in fastapi/links.db
tests/links.test.js       shared HTTP tests (node --test)
scripts/find-collision.js one-off search for two URLs whose codes clash (used by the tests)
```

## Run it

```sh
node node/server.js                                    # http://localhost:3000
cd fastapi && uv run uvicorn main:app --port 8000      # http://localhost:8000
```

Tests run against whichever server is up (they add rows to its database):

```sh
BASE_URL=http://localhost:3000 node --test tests/links.test.js
BASE_URL=http://localhost:8000 node --test tests/links.test.js
```

On PowerShell: `$env:BASE_URL="http://localhost:8000"; node --test tests/links.test.js`.

## API

| Request | Response |
|---|---|
| `GET /` | the page |
| `POST /api/links` `{"url": "...", "expires_in": 3600}` | **201** new link / **200** existing link → `{code, short_url, url, clicks, created_at, expires_at}` |
| `GET /api/links/{code}` | **200** the same JSON (expired links included) / **404** |
| `GET /{code}` | **302** to the URL and `clicks + 1` / **410** expired / **404** unknown |

Errors are always `{"error": "..."}`; bad input is **400**. Times are Unix seconds, and `expires_at: null` means "never".

```sh
curl --json '{"url": "https://example.com", "expires_in": 3600}' localhost:3000/api/links
```

## The rules

- **Codes:** SHA-256 of the URL exactly as sent (only surrounding whitespace trimmed), as one big integer, mod 62⁷, written as 7 characters of `0-9a-zA-Z`. So the same URL always gets the same code, and both versions agree (`https://example.com` → `6j2XRjj`).
- **Collisions:** if the code already belongs to a different URL (expired ones too), hash `"1:" + url`, then `"2:" + url`, … up to 10 tries. Rows are never deleted, so this chain stays stable and resubmitting a URL always finds it again.
- **Expiry:** `expires_in` is optional, 1 second to 1 year. Resubmitting a URL keeps the *later* expiry, and "never" beats any date, so nobody can cut someone else's link short, and an expired link comes back to life when resubmitted. In SQL this is just `max(expires_at, ?)`, because SQLite's `max()` returns NULL (never) if either side is NULL.
- **Redirects** are 302, not 301: browsers cache a 301 and skip the server, which would break click counting.
- **URLs** must be `http://` or `https://` and printable ASCII, at most 2048 characters. That blocks `javascript:` links, and it keeps the `Location` header safe.

## Differences worth noticing between the two

- **Concurrency.** Node runs one handler at a time and `node:sqlite` is synchronous, so there are no races. FastAPI runs `def` routes on a thread pool, so each request opens its own SQLite connection, and creating a link uses only single atomic statements (`INSERT … ON CONFLICT DO NOTHING`, then `UPDATE … WHERE url = ?`). Two threads racing on one URL end up with a 201 and a 200.
- **Validation.** Node checks types by hand. FastAPI uses a Pydantic model, but needed `strict=True` (otherwise `"60"` and `true` count as numbers), and the URL is a plain `str` because Pydantic's `HttpUrl` rewrites URLs (it adds a trailing `/`), which would change the hash.
- **Error format.** FastAPI answers bad input with 422 and `{"detail": [...]}`; two exception handlers turn that into the shared 400 + `{"error"}`. The error *wording* still differs between the two; only the status and shape are shared.
- **Edge cases the tests don't cover:** Node accepts `"expires_in": 1.0` (JavaScript can't tell `1.0` from `1`) and Pydantic strict rejects it. `POST /something` is 404 in Node and 405 in FastAPI. Node caps request bodies at 16 KB, while FastAPI has no limit. FastAPI only reads JSON when the request says `content-type: application/json`, so use `curl --json`, not `curl -d`.
