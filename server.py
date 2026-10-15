"""Loopback-only library, import, OCR and shared reading state for the prototype."""

import argparse
import hashlib
from collections import defaultdict
import json
import os
import shutil
import subprocess
import threading
import time
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from book_import import (
    ROOT,
    BOOK_ROOT,
    SUPPORTED,
    defaults,
    import_book,
    text_metadata,
    flatten_toc,
)
from pdf_enhancement import build_contents, recognize

from paths import DATA, RUNTIME, DEMO

MUTEX = threading.RLock()
WORKERS = ThreadPoolExecutor(max_workers=2)
RUNNING = set()
IMPORT_LOCKS = defaultdict(threading.Lock)


def load(path, fallback):
    return json.loads(path.read_text()) if path.is_file() else fallback


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def library():
    return load(DATA / "library.json", {"books": [], "jobs": []})


def book_for(ident):
    return next((book for book in library()["books"] if book["id"] == ident), None)


def update_book(ident, patch):
    with MUTEX:
        data = library()
        book = next(book for book in data["books"] if book["id"] == ident)
        book.update(patch)
        save(DATA / "library.json", data)
        save(BOOK_ROOT / ident / "book.json", book)
        return book


def start_job(ident):
    with MUTEX:
        if ident in RUNNING:
            return
        RUNNING.add(ident)
        data = library()
        book = next(book for book in data["books"] if book["id"] == ident)
        job = {
            "id": uuid.uuid4().hex,
            "book": ident,
            "title": book["title"],
            "status": "running",
            "phase": "准备文档解析",
            "startedAt": time.time(),
        }
        data["jobs"].insert(0, job)
        data["jobs"] = data["jobs"][:100]
        save(DATA / "library.json", data)

    def phase(text, status="running"):
        with MUTEX:
            data = library()
            entry = next(
                (entry for entry in data["jobs"] if entry["id"] == job["id"]), None
            )
            if entry:
                entry.update({"phase": text, "status": status})
                save(DATA / "library.json", data)

    def run():
        try:
            book = book_for(ident)
            if not book["parseEnabled"] and book["type"] != "txt":
                phase("已关闭增强解析", "ready")
                return
            if book["type"] == "pdf":
                patch = build_contents(book, phase)
                if book_for(ident)["parseEnabled"]:
                    update_book(ident, patch)
                phase(
                    patch.get("processingNote", "原书目录可用；文字在打开页面时准备。"),
                    "ready",
                )
            elif book["type"] == "txt":
                while True:
                    book = book_for(ident)
                    metadata = text_metadata(
                        BOOK_ROOT / ident / ("original." + book["format"].lower()),
                        BOOK_ROOT / ident,
                        book["parseEnabled"],
                    )
                    with MUTEX:
                        if book_for(ident)["parseEnabled"] != book["parseEnabled"]:
                            continue
                        update_book(
                            ident,
                            {
                                key: metadata[key]
                                for key in [
                                    "chapters",
                                    "toc",
                                    "contentUrl",
                                    "tocSource",
                                    "language",
                                ]
                            }
                            | {"processing": "ready"},
                        )
                        break
                phase("章节索引已更新。", "ready")
            else:
                # Additional structure is derived without changing EPUB documents or native navigation.
                index = [
                    {
                        "title": entry["title"],
                        "index": entry.get("index"),
                        "fragment": entry.get("fragment", ""),
                    }
                    for entry in flatten_toc(book.get("toc", []))
                ]
                save(BOOK_ROOT / ident / "structure-index.json", index)
                update_book(
                    ident,
                    {
                        "processing": "ready",
                        "structureIndexUrl": "/data/books/"
                        + ident
                        + "/structure-index.json",
                    },
                )
                phase("附加结构索引已准备；原书排版保留。", "ready")
        except Exception as error:
            update_book(ident, {"processing": "error", "processingNote": str(error)})
            phase(str(error), "error")
        finally:
            with MUTEX:
                RUNNING.discard(ident)

    WORKERS.submit(run)


def build_native():
    if sys.platform != "darwin" or not shutil.which("swiftc"):
        return
    RUNTIME.mkdir(parents=True, exist_ok=True)
    outputs = [(ROOT / "native/OCR.swift", RUNTIME / "ocr-page")]
    palm_bundle = RUNTIME / "页间掌上阅读.app"
    palm_binary = palm_bundle / "Contents/MacOS/page-between-palm"
    if (ROOT / "native/Palm.swift").exists():
        outputs.append((ROOT / "native/Palm.swift", palm_binary))
        import plistlib

        palm_binary.parent.mkdir(parents=True, exist_ok=True)
        (palm_bundle / "Contents/Info.plist").write_bytes(
            plistlib.dumps(
                {
                    "CFBundleIdentifier": "local.pagebetween.palm"
                    + (".demo" if DEMO else ""),
                    "CFBundleName": "页间掌上阅读" + ("演示" if DEMO else ""),
                    "CFBundleDisplayName": "页间掌上阅读" + ("演示" if DEMO else ""),
                    "CFBundleExecutable": "page-between-palm",
                    "CFBundlePackageType": "APPL",
                    "LSUIElement": True,
                    "NSHighResolutionCapable": True,
                }
            )
        )
    for source, binary in outputs:
        if not binary.exists() or source.stat().st_mtime > binary.stat().st_mtime:
            binary.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(
                ["swiftc", "-O", "-swift-version", "5", str(source), "-o", str(binary)],
                check=True,
            )


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header(
            "Cache-Control",
            "public, max-age=31536000, immutable"
            if urlsplit(self.path).path.startswith(
                ("/assets/fonts/", "/assets/vendor/")
            )
            else "no-store",
        )
        self.send_header("X-Content-Type-Options", "nosniff")
        if urlsplit(self.path).path.startswith("/" + DATA.name + "/books/"):
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self' data: blob:; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; form-action 'none'; base-uri 'self'",
            )
        super().end_headers()

    def log_message(self, format, *arguments):
        if not self.path.startswith(("/api/state", "/api/library-version")):
            super().log_message(format, *arguments)

    def json(self, value, status=200):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def request_body(self, limit=2 * 1024 * 1024):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > limit:
            raise ValueError("文件或请求过大。")
        return self.rfile.read(length)

    def same_origin(self):
        port = self.server.server_port
        if self.headers.get("Host") not in {f"127.0.0.1:{port}", f"localhost:{port}"}:
            return False
        origin = self.headers.get("Origin")
        return origin is None or origin in {
            f"http://127.0.0.1:{port}",
            f"http://localhost:{port}",
        }

    def do_GET(self):
        route = urlsplit(self.path)
        query = parse_qs(route.query)
        try:
            if not self.same_origin():
                return self.json({"error": "请求来源不受支持。"}, 403)
            if route.path == "/api/library":
                return self.json(library())
            if route.path == "/api/library-version":
                return self.json(
                    {
                        "revision": (DATA / "library.json").stat().st_mtime_ns
                        if (DATA / "library.json").exists()
                        else 0
                    }
                )
            if route.path == "/api/formats":
                return self.json(
                    {
                        "formats": [
                            {
                                "extension": extension,
                                "parseDefault": defaults(extension),
                            }
                            for extension in sorted(SUPPORTED)
                        ],
                        "demo": DEMO,
                        "nativePalm": (
                            RUNTIME
                            / "页间掌上阅读.app/Contents/MacOS/page-between-palm"
                        ).exists(),
                    }
                )
            if route.path == "/api/state":
                state = load(
                    DATA / "state.json",
                    {
                        "schema": 2,
                        "revision": 0,
                        "prefs": {},
                        "positions": {},
                        "bookmarks": [],
                    },
                )
                return self.json(state)
            if route.path == "/api/ocr":
                book = book_for(query.get("book", [""])[0])
                page = int(query.get("page", ["0"])[0])
                if not book or book["type"] != "pdf":
                    raise ValueError("找不到这本 PDF。")
                if not book["parseEnabled"]:
                    return self.json({"disabled": True, "lines": []})
                return self.json(recognize(book, page))
            if route.path == "/api/palm-status":
                return self.json(load(DATA / "palm-window.json", {}))
            requested = Path(unquote(route.path))
            if (
                any(part.startswith(".") for part in requested.parts)
                or "__pycache__" in requested.parts
            ):
                return self.send_error(404)
            if requested.parts[1:2] in [("data",), ("demo-data",)] and (
                len(requested.parts) < 3
                or requested.parts[1] != DATA.name
                or requested.parts[2] != "books"
            ):
                return self.send_error(404)
            return super().do_GET()
        except Exception as error:
            self.json({"error": str(error)}, 400)

    def do_POST(self):
        if not self.same_origin():
            return self.json({"error": "请求来源不受支持。"}, 403)
        route = urlsplit(self.path)
        query = parse_qs(route.query)
        try:
            if route.path == "/api/import":
                name = Path(query.get("name", [""])[0]).name
                if not name or len(name) > 240 or "\x00" in name:
                    raise ValueError("文件名无效。")
                extension = Path(name).suffix.lower()
                if extension not in SUPPORTED:
                    raise ValueError("暂不支持这个格式。")
                data = self.request_body(200 * 1024 * 1024)
                digest = hashlib.sha256(data).hexdigest()
                with IMPORT_LOCKS[digest]:
                    duplicate = next(
                        (
                            old
                            for old in library()["books"]
                            if old["sourceHash"] == digest
                        ),
                        None,
                    )
                    if duplicate:
                        return self.json({"book": duplicate, "duplicate": True})
                    incoming = DATA / "incoming" / uuid.uuid4().hex
                    incoming.mkdir(parents=True)
                    source = incoming / name
                    source.write_bytes(data)
                    try:
                        book = import_book(
                            source,
                            enabled=query.get(
                                "parse", ["1" if defaults(extension) else "0"]
                            )[0]
                            == "1",
                            shelf=query.get("shelf", [""])[0] or None,
                        )
                        with MUTEX:
                            collection = library()
                            collection["books"].append(book)
                            save(DATA / "library.json", collection)
                        if book["parseEnabled"]:
                            start_job(book["id"])
                        return self.json({"book": book})
                    finally:
                        shutil.rmtree(incoming, ignore_errors=True)
            payload = json.loads(self.request_body())
            if route.path == "/api/state":
                with MUTEX:
                    state = load(
                        DATA / "state.json",
                        {
                            "schema": 2,
                            "revision": 0,
                            "prefs": {},
                            "positions": {},
                            "bookmarks": [],
                        },
                    )
                    if isinstance(payload.get("prefs"), dict):
                        state.setdefault("prefs", {}).update(payload["prefs"])
                    for ident, position in payload.get("positions", {}).items():
                        if isinstance(position, dict) and position.get(
                            "updatedAt", 0
                        ) >= state.setdefault("positions", {}).get(ident, {}).get(
                            "updatedAt", 0
                        ):
                            state["positions"][ident] = position
                    for field in ["bookmarks", "lastBook", "schema"]:
                        if field in payload:
                            state[field] = payload[field]
                    changes = payload.get("bookmarkChanges", {})
                    if changes:
                        state["bookmarks"] = [
                            mark
                            for mark in state.get("bookmarks", [])
                            if mark["id"] not in changes.get("remove", [])
                        ]
                        known = {mark["id"] for mark in state["bookmarks"]}
                        state["bookmarks"].extend(
                            mark
                            for mark in changes.get("add", [])
                            if mark.get("id") and mark["id"] not in known
                        )
                    state["revision"] = state.get("revision", 0) + 1
                    state["writer"] = str(payload.get("writer", ""))[:80]
                    save(DATA / "state.json", state)
                return self.json(state)
            if route.path.startswith("/api/books/"):
                ident = route.path.rsplit("/", 1)[-1]
                book = book_for(ident)
                if not book:
                    raise ValueError("找不到这本书。")
                patch = {
                    key: payload[key]
                    for key in ["parseEnabled", "onShelf", "shelf", "title"]
                    if key in payload
                }
                if "parseEnabled" in patch and not isinstance(
                    patch["parseEnabled"], bool
                ):
                    raise ValueError("解析开关无效。")
                if "pageOffset" in payload:
                    offset = int(payload["pageOffset"])
                    if abs(offset) > book.get("pages", 0):
                        raise ValueError("页码偏移无效。")
                    patch["pageOffset"] = offset
                    for entry in flatten_toc(book.get("toc", [])):
                        if isinstance(entry.get("printed"), int):
                            entry["index"] = (
                                entry["printed"] + offset
                                if 1 <= entry["printed"] + offset <= book["pages"]
                                else None
                            )
                    patch["toc"] = book["toc"]
                result = update_book(ident, patch)
                if "parseEnabled" in patch:
                    if book["type"] == "txt" or patch["parseEnabled"]:
                        start_job(ident)
                return self.json({"book": result})
            if route.path == "/api/palm":
                book = book_for(payload.get("book"))
                if (
                    not book
                    or book["type"] == "pdf"
                    or book.get("layout") in {"comic", "pre-paginated"}
                ):
                    raise ValueError("掌上模式用于可重排的文字书。")
                binary = RUNTIME / "页间掌上阅读.app/Contents/MacOS/page-between-palm"
                if not binary.exists():
                    raise ValueError("掌上窗口尚未准备好，请重启本地服务。")
                port = self.server.server_port
                url = f"http://127.0.0.1:{port}/?mode=palm&native=1&book=" + book["id"]
                with MUTEX:
                    status = load(DATA / "palm-window.json", {})
                    if status.get("visible") and status.get("pid"):
                        try:
                            os.kill(int(status["pid"]), 0)
                            save(
                                DATA / "palm-command.json",
                                {"url": url, "nonce": uuid.uuid4().hex},
                            )
                            return self.json({"opened": True, "reused": True})
                        except (OSError, ValueError):
                            pass
                    (DATA / "palm-command.json").unlink(missing_ok=True)
                    with (DATA / "palm.log").open("a") as log:
                        process = subprocess.Popen(
                            [str(binary), url, str(DATA / "palm-window.json")],
                            stdout=log,
                            stderr=log,
                            start_new_session=True,
                        )
                    save(
                        DATA / "palm-window.json",
                        {
                            "visible": True,
                            "loaded": False,
                            "pid": process.pid,
                            "url": url,
                        },
                    )
                    return self.json({"opened": True})
            return self.json({"error": "没有这个接口。"}, 404)
        except Exception as error:
            self.json({"error": str(error)}, 400)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8779 if DEMO else 8778)
    parser.add_argument("--demo", action="store_true")
    arguments = parser.parse_args()
    build_native()
    if not (DATA / "library.json").exists():
        if DEMO:
            from scripts.create_demo import prepare

            prepare()
        else:
            save(DATA / "library.json", {"books": [], "jobs": []})
    server = ThreadingHTTPServer(
        ("127.0.0.1", arguments.port), partial(Handler, directory=str(ROOT))
    )
    for book in library()["books"]:
        if (
            book["type"] == "pdf"
            and book["parseEnabled"]
            and book.get("processing") == "pending"
        ):
            start_job(book["id"])
    print(f"页间：http://127.0.0.1:{arguments.port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
