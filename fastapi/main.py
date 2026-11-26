"""URL shortener, FastAPI version. Same routes, table and rules as ../node/server.js."""

import hashlib
import re
import sqlite3
import time
from contextlib import closing
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

MAX_URL = 2048
MAX_EXPIRES_IN = 31_536_000  # 1 year, in seconds
ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
# shortcut: printable ASCII only (what browsers copy from the address bar); to accept raw Unicode, percent-encode it before it goes in the Location header.
URL_RE = re.compile(r"https?://[!-~]+", re.IGNORECASE)
HERE = Path(__file__).parent
DB = HERE / "links.db"
PAGE = HERE.parent / "web" / "index.html"

INSERT = "INSERT INTO links (code, url, created_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (code) DO NOTHING RETURNING *"
# SQLite's max() returns NULL if either side is NULL, and NULL means "never", so "never" beats any date.
EXTEND = "UPDATE links SET expires_at = max(expires_at, ?) WHERE code = ? AND url = ? RETURNING *"
FIND = "SELECT * FROM links WHERE code = ?"
CLICK = "UPDATE links SET clicks = clicks + 1 WHERE code = ? AND (expires_at IS NULL OR expires_at > ?) RETURNING url"


def connect():
    # One connection per request: sync routes run on a thread pool, and a sqlite3 connection must not be shared across threads.
    con = sqlite3.connect(DB, autocommit=True)
    con.row_factory = sqlite3.Row
    return con


def one(con, sql, args):
    rows = con.execute(sql, args).fetchall()  # fetchall runs the statement to the end, so a RETURNING write commits now
    return rows[0] if rows else None


with closing(connect()) as con:
    con.execute("""CREATE TABLE IF NOT EXISTS links (
      code       TEXT PRIMARY KEY,
      url        TEXT NOT NULL,
      clicks     INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER -- NULL = never expires
    )""")

app = FastAPI()


class NewLink(BaseModel):
    model_config = ConfigDict(strict=True)  # like Node: "60" and true are not numbers
    url: str
    expires_in: int | None = Field(default=None, ge=1, le=MAX_EXPIRES_IN)


def now():
    return int(time.time())


def code_for(text):
    """SHA-256 -> big integer -> mod 62^7 -> 7 base62 characters."""
    n = int(hashlib.sha256(text.encode()).hexdigest(), 16) % 62**7
    code = ""
    for _ in range(7):
        n, r = divmod(n, 62)
        code = ALPHABET[r] + code
    return code


def error(status, message):
    return JSONResponse({"error": message}, status_code=status)


def show(row, request, status=200):
    return JSONResponse(dict(row) | {"short_url": f"{request.base_url}{row['code']}"}, status_code=status)


@app.exception_handler(RequestValidationError)
def bad_request(request, exc):
    # FastAPI's default is 422 with its own shape; the shared contract is 400 + {"error"}.
    first = exc.errors()[0]
    return error(400, f"{'.'.join(map(str, first['loc']))}: {first['msg']}")


@app.exception_handler(StarletteHTTPException)
def http_error(request, exc):
    return error(exc.status_code, exc.detail)


@app.get("/")
def page():
    return FileResponse(PAGE)


# shortcut: no request body size limit (Node caps it at 16 KB); put a proxy with one in front before exposing this.
@app.post("/api/links")
def create(link: NewLink, request: Request):
    url = link.url.strip()
    if len(url) > MAX_URL or not URL_RE.fullmatch(url):
        return error(400, f"url must be an http(s) URL of printable ASCII, at most {MAX_URL} characters")
    expires_at = None if link.expires_in is None else now() + link.expires_in

    # Same URL -> same code. If the code belongs to a different URL, try "1:url", "2:url", ...
    # Safe under the thread pool: each statement is atomic, so two threads racing on one URL end up at 201 + 200.
    with closing(connect()) as con:
        for attempt in range(10):
            code = code_for(f"{attempt}:{url}" if attempt else url)
            if row := one(con, INSERT, (code, url, now(), expires_at)):
                return show(row, request, 201)
            if row := one(con, EXTEND, (expires_at, code, url)):
                return show(row, request, 200)
    return error(500, "no free code after 10 attempts")


@app.get("/api/links/{code}")
def info(code: str, request: Request):
    with closing(connect()) as con:
        row = one(con, FIND, (code,))
    return show(row, request) if row else error(404, "link not found")


@app.get("/{code}")
def follow(code: str):
    with closing(connect()) as con:
        if row := one(con, CLICK, (code, now())):
            return Response(status_code=302, headers={"location": row["url"]})
        if one(con, FIND, (code,)):
            return error(410, "link expired")
    return error(404, "link not found")
