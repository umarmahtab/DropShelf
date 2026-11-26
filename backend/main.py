"""DropShelf's single-process file server. See guide.md for configuration."""
import asyncio
import hashlib
import json
import zipfile
import os
import secrets
import socket
import sqlite3
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager, closing, contextmanager, suppress
from pathlib import Path
from urllib.parse import unquote

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.getenv("DROPSHELF_DATA", ROOT / "data")).resolve()
FILES = DATA / "uploads"
LIMIT = 5_000_000_000
QUOTA = int(os.getenv("DROPSHELF_QUOTA_MIB", "20480")) * 1024**2
attempts = defaultdict(deque)
reservations = {}


@contextmanager
def database():
    with closing(sqlite3.connect(DATA / "shelf.sqlite3", timeout=10)) as db:
        db.row_factory = sqlite3.Row
        with db:
            yield db


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def password_hash(password, salt):
    return hashlib.scrypt(password.encode(), salt=salt, n=2**15, r=8, p=1, maxmem=64*1024**2)


def remove_files(drop_id):
    for path in FILES.glob(drop_id + "*"):
        path.unlink(missing_ok=True)


def cleanup():
    now = time.time()
    with database() as db:
        for row in db.execute("SELECT id FROM drops WHERE expires<=?", (now,)).fetchall():
            try:
                remove_files(row["id"])
            except PermissionError:
                continue  # Retry on the next pass if Windows is serving this file.
            db.execute("DELETE FROM drops WHERE id=?", (row["id"],))
        db.execute("DELETE FROM tickets WHERE expires<=? OR id NOT IN (SELECT id FROM drops)", (now,))
        for table in ("bundles", "pickups"):
            db.execute(f"DELETE FROM {table} WHERE id NOT IN (SELECT id FROM drops)")
        db.execute("DELETE FROM access WHERE drop_id NOT IN (SELECT id FROM drops)")
        db.execute("DELETE FROM submissions WHERE drop_id NOT IN (SELECT id FROM drops)")
        db.execute("DELETE FROM inboxes WHERE expires<=?", (now,))
    for key in list(attempts):
        if not attempts[key] or attempts[key][-1] < now - 60:
            del attempts[key]


async def sweep():
    while True:
        await asyncio.sleep(30)
        cleanup()


@asynccontextmanager
async def lifespan(app):
    FILES.mkdir(parents=True, exist_ok=True)
    with database() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS drops (id TEXT PRIMARY KEY, name TEXT, size INTEGER,
          salt BLOB, password BLOB, owner TEXT, expires REAL);
        CREATE TABLE IF NOT EXISTS tickets (token TEXT PRIMARY KEY, id TEXT, expires REAL);
        CREATE TABLE IF NOT EXISTS bundles (id TEXT PRIMARY KEY, manifest TEXT);
        CREATE TABLE IF NOT EXISTS pickups (id TEXT, token TEXT, started REAL, PRIMARY KEY(id,token));
        CREATE TABLE IF NOT EXISTS access (id TEXT PRIMARY KEY, drop_id TEXT, name TEXT, proof TEXT, state TEXT);
        CREATE TABLE IF NOT EXISTS inboxes (id TEXT PRIMARY KEY, title TEXT, owner TEXT, expires REAL);
        CREATE TABLE IF NOT EXISTS submissions (inbox_id TEXT, drop_id TEXT PRIMARY KEY);
        """)
        known = {row[0] for row in db.execute("SELECT id FROM drops")}
    # The uploads directory belongs exclusively to DropShelf. Recover interrupted writes.
    for file in FILES.iterdir():
        if file.is_file() and file.name.startswith("drop_") and file.name.split(".")[0] not in known:
            file.unlink()
    cleanup()
    worker = asyncio.create_task(sweep())
    try:
        yield
    finally:
        worker.cancel()
        with suppress(asyncio.CancelledError):
            await worker


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)
origins = [x.strip() for x in os.getenv("DROPSHELF_ORIGINS", "").split(",") if x.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET","POST","DELETE"],
                   allow_headers=["Content-Type","X-File-Name","X-Drop-Password","X-Expires-Hours","X-File-Manifest","Authorization"])


@app.middleware("http")
async def response_headers(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


def active(drop_id):
    with database() as db:
        row = db.execute("SELECT * FROM drops WHERE id=? AND expires>?", (drop_id, time.time())).fetchone()
    if not row:
        raise HTTPException(410, "This drop has expired or was revoked.")
    return row


def rate(key, maximum):
    window = attempts[key]
    now = time.time()
    while window and window[0] <= now - 60:
        window.popleft()
    if len(window) >= maximum:
        raise HTTPException(429, "Too many attempts. Try again in a minute.")
    window.append(now)


@app.get("/api/network")
def network(request: Request):
    host = request.url.hostname
    if host in ("localhost", "127.0.0.1", "::1"):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("192.0.2.1", 9))
                host = s.getsockname()[0]
        except OSError:
            pass
    return {"host": host}


def clean_name(value):
    name = value.replace(chr(92), "/").split("/")[-1]
    if name in {"", ".", ".."} or len(name) > 255 or any(ord(c) < 32 for c in name):
        raise ValueError("Invalid filename")
    return name


def build_bundle(path, manifest):
    with path.open("rb") as source, zipfile.ZipFile(path.with_suffix(".zip"), "w") as archive:
        used = set()
        for index, item in enumerate(manifest):
            name = item["name"]
            while name.casefold() in used:
                name = "_" + name
            used.add(name.casefold())
            with path.with_suffix(f".{index}").open("wb") as target, archive.open(name, "w", force_zip64=item["size"] >= zipfile.ZIP64_LIMIT) as entry:
                remaining = item["size"]
                while remaining:
                    chunk = source.read(min(remaining, 1024**2))
                    target.write(chunk)
                    entry.write(chunk)
                    remaining -= len(chunk)
    path.with_suffix(".zip").replace(path)


@app.post("/api/drops", status_code=201)
async def upload(request: Request):
    return await store_upload(request)


async def store_upload(request, inbox=None):
    if request.headers.get("content-type") != "application/octet-stream":
        raise HTTPException(415, "Choose a file to upload.")
    password = secrets.token_urlsafe(24) if inbox else unquote(request.headers.get("x-drop-password", ""))
    name = unquote(request.headers.get("x-file-name", "")).replace("\\", "/").split("/")[-1]
    hours = "24" if inbox else request.headers.get("x-expires-hours", "")
    if name in {"", ".", ".."} or len(name)>255 or any(ord(c)<32 for c in name):
        raise HTTPException(400, "Choose a file with a valid name.")
    if not password or hours not in {"1","24","168"}:
        raise HTTPException(400, "Enter a password and choose a listed expiry.")
    rate(("create",request.client.host), 20)
    length = request.headers.get("content-length","")
    if not length.isdecimal():
        raise HTTPException(411, "Upload requires a known file size.")
    size = int(length)
    if size > LIMIT:
        raise HTTPException(413, "Upload limit is 5 GB.")
    manifest = []
    raw_manifest = request.headers.get("x-file-manifest")
    if raw_manifest:
        try:
            items = json.loads(unquote(raw_manifest))
            if not isinstance(items, list) or not 2 <= len(items) <= 10:
                raise ValueError()
            for item in items:
                if type(item["size"]) is not int or item["size"] < 0:
                    raise ValueError()
                manifest.append({"name": clean_name(item["name"]), "size": item["size"]})
            if sum(item["size"] for item in manifest) != size:
                raise ValueError()
        except (ValueError, TypeError, KeyError, AttributeError):
            raise HTTPException(400, "Choose between two and ten valid files.")
        name = "DropShelf files.zip"
    disk_size = size * 3 + 16384 if manifest else size
    with database() as db:
        used = db.execute("SELECT COALESCE(SUM(size + CASE WHEN id IN (SELECT id FROM bundles) THEN size + 16384 ELSE 0 END),0) FROM drops").fetchone()[0]
    if used + sum(reservations.values()) + disk_size > QUOTA:
        raise HTTPException(507, "This shelf is full. Remove a drop and try again.")
    drop_id = "drop_" + secrets.token_urlsafe(18)
    reservations[drop_id] = disk_size
    path = FILES / drop_id
    owner, salt = secrets.token_urlsafe(32), secrets.token_bytes(16)
    try:
        received = 0
        with path.open("xb") as f:
            async for chunk in request.stream():
                received += len(chunk)
                if received > size:
                    raise HTTPException(413, "Unexpected upload size.")
                await run_in_threadpool(f.write, chunk)
        if received != size:
            raise HTTPException(400, "Upload was interrupted.")
        if manifest:
            await run_in_threadpool(build_bundle, path, manifest)
        hashed = await run_in_threadpool(password_hash, password, salt)
        expires = time.time() + int(hours)*3600
        if inbox:
            expires = inbox["expires"]
        with database() as db:
            if expires <= time.time():
                raise HTTPException(410, "This request expired.")
            db.execute("INSERT INTO drops VALUES (?,?,?,?,?,?,?)",
                       (drop_id,name,size,salt,hashed,digest(owner),expires))
            if manifest:
                db.execute("INSERT INTO bundles VALUES (?,?)", (drop_id,json.dumps(manifest)))
            if inbox:
                db.execute("INSERT INTO submissions VALUES (?,?)", (inbox["id"],drop_id))
    except BaseException:
        remove_files(drop_id)
        raise
    finally:
        reservations.pop(drop_id, None)
    return {"received": True} if inbox else {"id":drop_id,"name":name,"size":size,"expires":expires,"owner":owner}


@app.get("/api/drops/{drop_id}")
def status(drop_id: str):
    return {"expires": active(drop_id)["expires"]}


class Unlock(BaseModel):
    password: str


@app.post("/api/drops/{drop_id}/unlock")
async def unlock(drop_id: str, body: Unlock, request: Request):
    row = active(drop_id)
    rate(("unlock",request.client.host), 20)
    candidate = await run_in_threadpool(password_hash, body.password, row["salt"])
    if not secrets.compare_digest(candidate, row["password"]):
        raise HTTPException(403, "That password didn’t match. Try again.")
    return issue_ticket(row)


def issue_ticket(row):
    token = secrets.token_urlsafe(32)
    with database() as db:
        db.execute("INSERT INTO tickets VALUES (?,?,?)", (digest(token),row["id"],row["expires"]))
        bundle = db.execute("SELECT manifest FROM bundles WHERE id=?", (row["id"],)).fetchone()
    return {"name":row["name"],"size":row["size"],"ticket":token,
            "files":json.loads(bundle["manifest"]) if bundle else []}


@app.get("/api/drops/{drop_id}/file/{ticket}")
def download(drop_id: str, ticket: str, part: int | None = None):
    row = active(drop_id)
    with database() as db:
        valid = db.execute("SELECT 1 FROM tickets WHERE token=? AND id=? AND expires>?",
                           (digest(ticket),drop_id,time.time())).fetchone()
    if not valid:
        raise HTTPException(403, "Unlock the drop again to download.")
    path, name = FILES / drop_id, row["name"]
    with database() as db:
        if part is not None:
            bundle = db.execute("SELECT manifest FROM bundles WHERE id=?", (drop_id,)).fetchone()
            files = json.loads(bundle["manifest"]) if bundle else []
            if not 0 <= part < len(files):
                raise HTTPException(404, "File not found.")
            path, name = path.with_suffix(f".{part}"), files[part]["name"]
        db.execute("INSERT OR IGNORE INTO pickups VALUES (?,?,?)", (drop_id,digest(ticket),time.time()))
    return FileResponse(path, filename=name, media_type="application/octet-stream")


@app.delete("/api/drops/{drop_id}")
async def revoke(drop_id: str, request: Request):
    row = active(drop_id)
    owner = request.headers.get("authorization","").removeprefix("Bearer ")
    if not secrets.compare_digest(digest(owner),row["owner"]):
        raise HTTPException(403, "Only the sender can revoke this drop.")
    with database() as db:
        db.execute("UPDATE drops SET expires=0 WHERE id=?", (drop_id,))
    cleanup()
    return {"revoked":True}


def authorize(request, expected):
    token = request.headers.get("authorization", "").removeprefix("Bearer ")
    if not secrets.compare_digest(digest(token), expected):
        raise HTTPException(403, "This browser does not have management access.")


class Label(BaseModel):
    name: str = Field(min_length=1, max_length=80)


@app.get("/api/drops/{drop_id}/activity")
def activity(drop_id: str, request: Request):
    authorize(request, active(drop_id)["owner"])
    with database() as db:
        pickups = db.execute("SELECT COUNT(*) AS count, MAX(started) AS latest FROM pickups WHERE id=?", (drop_id,)).fetchone()
        access = db.execute("SELECT id,name,state FROM access WHERE drop_id=? ORDER BY rowid DESC", (drop_id,)).fetchall()
    return {"count": pickups["count"], "latest": pickups["latest"], "requests": [dict(row) for row in access]}


@app.post("/api/drops/{drop_id}/access")
async def ask(drop_id: str, body: Label, request: Request):
    active(drop_id)
    rate(("ask", request.client.host), 10)
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Enter your name.")
    key = secrets.token_urlsafe(24)
    proof = secrets.token_urlsafe(32)
    with database() as db:
        db.execute("INSERT INTO access VALUES (?,?,?,?,?)", (key,drop_id,name,digest(proof),"pending"))
    return {"key": key, "proof": proof}


@app.post("/api/drops/{drop_id}/access/{key}/decision")
def decide(drop_id: str, key: str, request: Request, approve: bool):
    authorize(request, active(drop_id)["owner"])
    with database() as db:
        result = db.execute("UPDATE access SET state=? WHERE id=? AND drop_id=? AND state='pending'",
                            ("approved" if approve else "declined",key,drop_id))
        if not result.rowcount:
            raise HTTPException(409, "This request has already been handled.")
    return {"ok": True}


@app.post("/api/drops/{drop_id}/access/{key}/check")
def check_access(drop_id: str, key: str, request: Request):
    row = active(drop_id)
    with database() as db:
        entry = db.execute("SELECT * FROM access WHERE id=? AND drop_id=?", (key,drop_id)).fetchone()
    if not entry:
        raise HTTPException(404, "Access request unavailable.")
    authorize(request, entry["proof"])
    return {"state": entry["state"], "file": issue_ticket(row) if entry["state"] == "approved" else None}


def get_inbox(inbox_id):
    with database() as db:
        row = db.execute("SELECT * FROM inboxes WHERE id=? AND expires>?", (inbox_id,time.time())).fetchone()
    if not row:
        raise HTTPException(410, "This file request has expired.")
    return row


@app.post("/api/inboxes", status_code=201)
async def create_inbox(body: Label, request: Request):
    rate(("inbox",request.client.host), 10)
    title = body.name.strip()
    if not title:
        raise HTTPException(400, "Enter a request title.")
    inbox_id, owner = secrets.token_urlsafe(18), secrets.token_urlsafe(32)
    expires = time.time() + 7*86400
    with database() as db:
        db.execute("INSERT INTO inboxes VALUES (?,?,?,?)", (inbox_id,title,digest(owner),expires))
    return {"id": inbox_id, "title": title, "owner": owner, "expires": expires}


@app.get("/api/inboxes/{inbox_id}")
def inbox_status(inbox_id: str):
    row = get_inbox(inbox_id)
    return {"title": row["title"], "expires": row["expires"]}


@app.post("/api/inboxes/{inbox_id}/files", status_code=201)
async def submit_file(inbox_id: str, request: Request):
    return await store_upload(request, get_inbox(inbox_id))


@app.get("/api/inboxes/{inbox_id}/files")
def inbox_files(inbox_id: str, request: Request):
    authorize(request, get_inbox(inbox_id)["owner"])
    with database() as db:
        rows = db.execute("""SELECT drops.id, name, size FROM drops JOIN submissions
                             ON drops.id=submissions.drop_id WHERE inbox_id=? AND expires>?
                             ORDER BY drops.rowid DESC""", (inbox_id,time.time())).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/inboxes/{inbox_id}/files/{drop_id}")
def inbox_download(inbox_id: str, drop_id: str, request: Request):
    authorize(request, get_inbox(inbox_id)["owner"])
    with database() as db:
        match = db.execute("SELECT 1 FROM submissions WHERE inbox_id=? AND drop_id=?", (inbox_id,drop_id)).fetchone()
    if not match:
        raise HTTPException(404, "File not found.")
    return issue_ticket(active(drop_id))


if (ROOT / "out").is_dir():
    app.mount("/", StaticFiles(directory=ROOT / "out", html=True), name="web")
