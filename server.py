"""Loopback-only library, import, OCR and shared reading state for the prototype."""

import argparse
import hashlib
import hmac
from collections import defaultdict
import json
import os
import re
import shutil
import subprocess
import threading
import time
import sys
import uuid
import tempfile
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import SimpleCookie, CookieError
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
    url_for,
    path_for,
)
from pdf_enhancement import build_contents, recognize, page_enrichment
from pdf_selection import align_spans

from paths import DATA, RUNTIME, DEMO, APP_MODE, DATA_PREFIX, CACHE
from storage import load, save
import ai_tutor
import service_settings
import mineru_api
import book_index
import epub_export
import library_data

MUTEX = threading.RLock()
WORKERS = ThreadPoolExecutor(max_workers=2)
RUNNING = set()
CANCELS = {}
IMPORT_LOCKS = defaultdict(threading.Lock)
RECOVERY_LOCK = threading.Lock()
SESSION = os.environ.pop("PAGE_BETWEEN_SESSION", "")


class ReaderServer(ThreadingHTTPServer):
    # ES modules and fonts arrive together when a fresh window opens.
    request_queue_size = 64


def session_matches(value):
    return hmac.compare_digest(value.encode(), SESSION.encode())


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


def start_job(ident, kind="local", pages=None, fresh=False):
    with MUTEX:
        if ident in RUNNING:
            return False
        data = library()
        book = next(book for book in data["books"] if book["id"] == ident)
        RUNNING.add(ident)
        cancellation = threading.Event()
        reset_id = (
            fresh if isinstance(fresh, str) else uuid.uuid4().hex if fresh else None
        )
        CANCELS[ident] = cancellation
        note = "准备云端精细解析" if kind == "mineru" else "准备文档解析"
        book.update(
            {"processing": "pending", "processingNote": note, "processingKind": kind}
        )
        job = {
            "id": uuid.uuid4().hex,
            "book": ident,
            "title": book["title"],
            "status": "running",
            "phase": note,
            "kind": kind,
            "pages": pages or [],
            "resetId": reset_id,
            "startedAt": time.time(),
        }
        data["jobs"] = [entry for entry in data["jobs"] if entry.get("book") != ident]
        data["jobs"].insert(0, job)
        data["jobs"] = data["jobs"][:100]
        save(DATA / "library.json", data)
        save(BOOK_ROOT / ident / "book.json", book)

    def phase(text, status="running"):
        with MUTEX:
            data = library()
            entry = next(
                (entry for entry in data["jobs"] if entry["id"] == job["id"]), None
            )
            book = next((book for book in data["books"] if book["id"] == ident), None)
            if (
                kind == "mineru"
                and status == "running"
                and (cancellation.is_set() or not book or not book["parseEnabled"])
            ):
                raise mineru_api.Paused("云解析已暂停，可稍后继续。")
            if book and status in {"ready", "error", "paused"}:
                if not book["parseEnabled"] and book["type"] != "txt":
                    text, status = "已关闭增强解析，保留原书阅读。", "ready"
                book.update(
                    {
                        "processing": "ready" if status == "paused" else status,
                        "processingNote": text,
                    }
                )
                save(BOOK_ROOT / ident / "book.json", book)
            if entry:
                entry.update({"phase": text, "status": status})
            save(DATA / "library.json", data)

    def run():
        try:
            book = book_for(ident)
            if not book["parseEnabled"] and book["type"] != "txt":
                phase("已关闭增强解析", "ready")
                return
            if kind == "mineru":
                patch = mineru_api.run(
                    book, pages, phase, cancellation, fresh=reset_id or False
                )
                if book_for(ident)["parseEnabled"] and not cancellation.is_set():
                    update_book(ident, patch)
                phase(patch["processingNote"], "ready")
            elif book["type"] == "pdf":
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
                        "structureIndexUrl": url_for(
                            BOOK_ROOT / ident / "structure-index.json"
                        ),
                    },
                )
                phase("附加结构索引已准备；原书排版保留。", "ready")
        except mineru_api.Paused as error:
            phase(str(error), "paused")
        except Exception as error:
            phase(str(error), "error")
        finally:
            with MUTEX:
                RUNNING.discard(ident)
                CANCELS.pop(ident, None)

    WORKERS.submit(run)
    return True


def build_native():
    if (
        getattr(sys, "frozen", False)
        or sys.platform != "darwin"
        or not shutil.which("swiftc")
    ):
        return
    RUNTIME.mkdir(parents=True, exist_ok=True)
    outputs = [
        (ROOT / "native/OCR.swift", RUNTIME / "ocr-page"),
        (ROOT / "native/Secrets.swift", RUNTIME / "service-secrets"),
    ]
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
                ["swiftc", "-O", "-swift-version", "5"]
                + (
                    ["-D", "PALM_STANDALONE", "-parse-as-library"]
                    if source.name == "Palm.swift"
                    else []
                )
                + [str(source), "-o", str(binary)],
                check=True,
            )


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        if SESSION and session_matches(self.headers.get("X-Page-Between-Session", "")):
            self.send_header(
                "Set-Cookie",
                "pb_session=" + SESSION + "; HttpOnly; SameSite=Strict; Path=/",
            )
        self.send_header(
            "Cache-Control",
            "public, max-age=31536000, immutable"
            if urlsplit(self.path).path.startswith(
                ("/assets/fonts/", "/assets/vendor/")
            )
            else "no-store",
        )
        self.send_header("X-Content-Type-Options", "nosniff")
        if urlsplit(self.path).path.startswith(DATA_PREFIX + "/books/"):
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self' data: blob:; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; form-action 'none'; base-uri 'self'",
            )
        super().end_headers()

    def log_message(self, format, *arguments):
        if not self.path.startswith(("/api/state", "/api/library-version")):
            super().log_message(format, *arguments)

    def translate_path(self, path):
        if urlsplit(path).path.startswith(DATA_PREFIX + "/books/"):
            return str(path_for(path))
        return super().translate_path(path)

    def list_directory(self, path):
        self.send_error(404)
        return None

    def do_HEAD(self):
        self.send_error(405)

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

    def receive_file(self, target, limit):
        remaining = int(self.headers.get("Content-Length", "0"))
        if not 0 < remaining <= limit:
            raise ValueError("文件为空或超过当前大小上限。")
        checksum = hashlib.sha256()
        with target.open("wb") as output:
            while remaining:
                block = self.rfile.read(min(1024 * 1024, remaining))
                if not block:
                    raise ValueError("文件传输已中断，请重新选择文件。")
                output.write(block)
                checksum.update(block)
                remaining -= len(block)
            output.flush()
            os.fsync(output.fileno())
        return checksum.hexdigest()

    def same_origin(self):
        port = self.server.server_port
        if self.headers.get("Host") not in {f"127.0.0.1:{port}", f"localhost:{port}"}:
            return False
        origin = self.headers.get("Origin")
        return origin is None or origin in {
            f"http://127.0.0.1:{port}",
            f"http://localhost:{port}",
        }

    def authenticated(self):
        if not SESSION:
            return True
        try:
            cookies = SimpleCookie(self.headers.get("Cookie", ""))
            cookie = cookies.get("pb_session")
            value = self.headers.get("X-Page-Between-Session", "") or (
                cookie.value if cookie else ""
            )
            return session_matches(value)
        except (CookieError, TypeError):
            return False

    def do_GET(self):
        route = urlsplit(self.path)
        query = parse_qs(route.query)
        try:
            if not self.same_origin():
                return self.json({"error": "请求来源不受支持。"}, 403)
            if route.path == "/api/health":
                return self.json({"ready": True, "desktop": APP_MODE})
            if not self.authenticated():
                return self.json({"error": "请通过页间 App 打开此阅读空间。"}, 401)
            if route.path == "/api/ai/status":
                return self.json(ai_tutor.status())
            if route.path == "/api/settings":
                return self.json(service_settings.public_settings())
            if route.path == "/api/ai/conversations":
                book = book_for(query.get("book", [""])[0])
                if not book:
                    raise ValueError("找不到这本书。")
                ident = query.get("id", [""])[0]
                return self.json(
                    {"conversation": ai_tutor.conversation(ident, book["id"])}
                    if ident
                    else {"conversations": ai_tutor.history(book["id"])}
                )
            if route.path == "/api/library":
                return self.json(library())
            if route.path == "/api/data/info":
                with RECOVERY_LOCK:
                    return self.json(library_data.information())
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
            if route.path.startswith("/api/downloads/"):
                name = route.path.removeprefix("/api/downloads/")
                if not re.fullmatch(r"[0-9a-f]{32}\.(?:epub|pbbackup)", name):
                    raise ValueError("导出文件地址无效。")
                path = CACHE / "exports" / name
                if not path.is_file():
                    raise ValueError("导出文件已过期，请重新导出。")
                self.send_response(200)
                self.send_header(
                    "Content-Type",
                    "application/epub+zip"
                    if name.endswith(".epub")
                    else "application/zip",
                )
                self.send_header("Content-Length", str(path.stat().st_size))
                self.send_header(
                    "Content-Disposition", 'attachment; filename="' + name + '"'
                )
                self.end_headers()
                with path.open("rb") as stream:
                    shutil.copyfileobj(stream, self.wfile)
                return
            if route.path == "/api/ocr":
                book = book_for(query.get("book", [""])[0])
                page = int(query.get("page", ["0"])[0])
                if not book or book["type"] != "pdf":
                    raise ValueError("找不到这本 PDF。")
                if not book["parseEnabled"]:
                    return self.json({"disabled": True, "lines": []})
                return self.json(recognize(book, page))
            if route.path == "/api/enrichment":
                book = book_for(query.get("book", [""])[0])
                page = int(query.get("page", ["0"])[0])
                if not book or book["type"] != "pdf" or not 1 <= page <= book["pages"]:
                    raise ValueError("原书页码无效。")
                return self.json({"blocks": page_enrichment(book, page)})
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
                or "/" + requested.parts[1] != DATA_PREFIX
                or requested.parts[2] != "books"
            ):
                return self.send_error(404)
            if route.path.startswith(DATA_PREFIX + "/books/"):
                ident = unquote(route.path[len(DATA_PREFIX + "/books/") :]).split("/")[
                    0
                ]
                if not book_for(ident):
                    return self.send_error(404)
            else:
                target = (ROOT / str(requested).lstrip("/")).resolve()
                entrypoints = {
                    (ROOT / name).resolve()
                    for name in (
                        "index.html",
                        "app-v2.mjs",
                        "core.mjs",
                        "page-layout.mjs",
                        "layout.css",
                        "epub-reader.css",
                        "assets/favicon.svg",
                    )
                }
                if route.path != "/" and not (
                    target in entrypoints
                    or (
                        target.is_relative_to((ROOT / "ui").resolve())
                        and target.suffix == ".mjs"
                    )
                    or any(
                        target.is_relative_to((ROOT / folder).resolve())
                        for folder in ("assets/fonts", "assets/vendor")
                    )
                ):
                    return self.send_error(404)
            return super().do_GET()
        except Exception as error:
            self.json({"error": str(error)}, 400)

    def do_POST(self):
        if not self.same_origin():
            return self.json({"error": "请求来源不受支持。"}, 403)
        if not self.authenticated():
            return self.json({"error": "阅读会话已过期，请重新打开 App。"}, 401)
        route = urlsplit(self.path)
        query = parse_qs(route.query)
        try:
            if route.path == "/api/data/restore":
                with (
                    RECOVERY_LOCK,
                    tempfile.TemporaryDirectory(
                        prefix=".backup-import-", dir=DATA.parent
                    ) as folder,
                ):
                    source = Path(folder) / "library.pbbackup"
                    self.receive_file(source, library_data.MAX_ARCHIVE)
                    return self.json(library_data.prepare_restore(source))
            if route.path == "/api/import":
                name = Path(query.get("name", [""])[0]).name
                if not name or len(name) > 240 or "\x00" in name:
                    raise ValueError("文件名无效。")
                extension = Path(name).suffix.lower()
                if extension not in SUPPORTED:
                    raise ValueError("暂不支持这个格式。")
                incoming = DATA / "incoming" / uuid.uuid4().hex
                incoming.mkdir(parents=True)
                source = incoming / name
                try:
                    digest = self.receive_file(source, 200 * 1024 * 1024)
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
            if route.path == "/api/data/backup":
                with MUTEX, ai_tutor.LOCK:
                    snapshot = {
                        "library.json": library(),
                        "state.json": load(DATA / "state.json", {}),
                        "ai-conversations.json": ai_tutor.records(),
                    }
                result = library_data.backup(snapshot)
                return self.json(
                    {**result, "download": "/api/downloads/" + result["id"]}
                )
            if route.path == "/api/data/approve-restore":
                with RECOVERY_LOCK:
                    return self.json(library_data.approve_restore())
            if route.path == "/api/data/cancel-restore":
                with RECOVERY_LOCK:
                    library_data.cancel_restore()
                return self.json({"cancelled": True})
            if route.path == "/api/data/previous":
                with RECOVERY_LOCK:
                    return self.json(library_data.prepare_previous())
            if route.path == "/api/data/clear-cache":
                return self.json(library_data.queue_cache_cleanup())
            if route.path == "/api/export/epub":
                book = book_for(payload.get("book"))
                if not book:
                    raise ValueError("找不到这本书。")
                pages = (
                    mineru_api.page_range(payload.get("pages"), book["pages"])
                    if book["type"] == "pdf"
                    else None
                )
                result = epub_export.build(book, pages)
                return self.json(
                    {**result, "download": "/api/downloads/" + result["id"]}
                )
            if route.path == "/api/index/search":
                book = book_for(payload.get("book"))
                if not book:
                    raise ValueError("找不到这本书。")
                if type(payload.get("previousOnly", False)) is not bool:
                    raise ValueError("检索范围无效。")
                return self.json(
                    book_index.search(
                        book,
                        payload.get("query", ""),
                        position=payload.get("position"),
                        previous_only=payload.get("previousOnly", False),
                    )
                )
            if route.path == "/api/pdf/align":
                book = book_for(payload.get("book"))
                page = payload.get("page")
                if (
                    not book
                    or book["type"] != "pdf"
                    or type(page) is not int
                    or not 1 <= page <= book["pages"]
                ):
                    raise ValueError("原书页码无效。")
                return self.json(
                    {
                        "groups": align_spans(
                            payload.get("spans"), page_enrichment(book, page)
                        )
                    }
                )
            if route.path == "/api/jobs/mineru":
                book = book_for(payload.get("book"))
                if not book or book["type"] != "pdf":
                    raise ValueError("请选择一本 PDF。")
                pages = mineru_api.page_range(payload.get("pages"), book["pages"])
                if type(payload.get("fresh", False)) is not bool:
                    raise ValueError("解析选项无效。")
                service_settings.validated(
                    "mineru", service_settings.effective("mineru"), require_key=True
                )
                with MUTEX:
                    if book["id"] in RUNNING:
                        return self.json(
                            {"error": "这本书已有任务进行中，请稍后再试。"}, 409
                        )
                    update_book(book["id"], {"parseEnabled": True})
                    start_job(
                        book["id"],
                        kind="mineru",
                        pages=pages,
                        fresh=payload.get("fresh", False),
                    )
                return self.json({"book": book_for(book["id"]), "started": True})
            if route.path == "/api/jobs/pause":
                ident = payload.get("book")
                with MUTEX:
                    pausing = ident in CANCELS
                    if ident in CANCELS:
                        CANCELS[ident].set()
                return self.json({"paused": pausing})
            if route.path in {"/api/settings/save", "/api/settings/test"}:
                if not isinstance(payload, dict):
                    raise ValueError("服务配置无效。")
                service = payload.get("service")
                config = payload.get("config")
                if route.path.endswith("/save"):
                    return self.json(service_settings.update(service, config))
                snapshot = service_settings.candidate(service, config, require_key=True)
                if service == "ai":
                    endpoint = snapshot["baseUrl"]
                    if not endpoint.endswith("/chat/completions"):
                        endpoint += "/chat/completions"
                    ai_tutor.complete(
                        {**snapshot, "url": endpoint},
                        [{"role": "user", "content": "这是连接测试，请只回复 OK。"}],
                        max_tokens=512,
                        timeout=45,
                    )
                    return self.json(
                        {"message": "连接成功，所选模型已返回回答。测试未保存设置。"}
                    )
                return self.json(
                    {
                        "message": "配置格式检查通过。Token 有效性将在实际解析任务中确认。",
                        "verified": False,
                    }
                )
            if route.path == "/api/ai/cancel":
                book = book_for(payload.get("book"))
                if not book:
                    raise ValueError("找不到这本书。")
                return self.json(
                    {
                        "conversation": ai_tutor.cancel(
                            payload.get("conversation"), book["id"]
                        )
                    }
                )
            if route.path in {"/api/ai/ask", "/api/ai/start"}:
                book = book_for(payload.get("book"))
                if not book:
                    raise ValueError("找不到这本书。")
                try:
                    action = (
                        ai_tutor.start
                        if route.path.endswith("/start")
                        else ai_tutor.ask
                    )
                    return self.json({"conversation": action(book, payload)})
                except ai_tutor.TutorError as error:
                    return self.json(
                        {"error": str(error), "conversation": error.conversation},
                        502 if error.conversation else 400,
                    )
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
                if "reparse" in payload and type(payload["reparse"]) is not bool:
                    raise ValueError("重试选项无效。")
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
                if (
                    payload.get("reparse")
                    or patch.get("parseEnabled", book["parseEnabled"])
                    != book["parseEnabled"]
                ):
                    if book["type"] == "txt" or result["parseEnabled"]:
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


def resume_pending_jobs():
    for book in library()["books"]:
        if book.get("processing") != "pending":
            continue
        if not book["parseEnabled"] and book["type"] != "txt":
            update_book(
                book["id"],
                {
                    "processing": "ready",
                    "processingNote": "已关闭增强解析，保留原书阅读。",
                },
            )
            continue
        previous = next(
            (job for job in library()["jobs"] if job.get("book") == book["id"]), {}
        )
        if (
            book["type"] == "pdf"
            and previous.get("kind") == "mineru"
            and previous.get("pages")
        ):
            start_job(
                book["id"],
                kind="mineru",
                pages=previous["pages"],
                fresh=previous.get("resetId") or False,
            )
        else:
            start_job(book["id"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8779 if DEMO else 8778)
    parser.add_argument("--demo", action="store_true")
    arguments = parser.parse_args()
    if APP_MODE:
        import fcntl
        import signal

        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        if os.getpgrp() != os.getpid():
            os.setsid()
        DATA.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        instance_lock = (DATA.parent / (DATA.name + ".instance.lock")).open("a")
        try:
            fcntl.flock(instance_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit(
                "此书库已由另一个页间进程使用，请先关闭已有窗口。"
            ) from None
    library_data.apply_pending_restore()
    library_data.apply_cache_cleanup()
    build_native()
    if not (DATA / "library.json").exists():
        if DEMO:
            from scripts.create_demo import prepare

            prepare()
        else:
            save(DATA / "library.json", {"books": [], "jobs": []})
    server = ReaderServer(
        ("127.0.0.1", arguments.port), partial(Handler, directory=str(ROOT))
    )
    parent = os.environ.pop("PAGE_BETWEEN_PARENT_PID", "")
    if APP_MODE and parent.isdigit():

        def follow_parent():
            while os.getppid() == int(parent):
                time.sleep(1)
            import signal

            os.killpg(os.getpgrp(), signal.SIGTERM)

        threading.Thread(target=follow_parent, daemon=True).start()
    resume_pending_jobs()
    if APP_MODE:
        print(json.dumps({"ready": True, "port": server.server_port}), flush=True)
    else:
        print(f"页间：http://127.0.0.1:{server.server_port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
