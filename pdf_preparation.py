"""Bounded local PDF preparation, with foreground pages ahead of whole-book work."""

import threading
import time
from concurrent.futures import Future, TimeoutError

from pdf_enhancement import (
    prepared_pages,
    recognize,
    saved_selection,
    selection_directory,
    source_path,
)
from storage import load, save


class PDFPreparation:
    def __init__(self, get_book, processor=None, foreground_processor=None):
        self.get_book = get_book
        self.processor = processor or (
            lambda book, page: recognize(
                book, page, allow_native=True, include_enrichment=False
            )
        )
        self.foreground_processor = foreground_processor or (
            lambda book, page: recognize(book, page, include_enrichment=False)
        )
        self.condition = threading.Condition()
        self.clients = {}
        self.jobs = {}
        self.failed_nearby = set()
        self.sequence = 0
        self.active = None
        self.thread = None
        self.foreground_thread = None
        self.foreground_active = None
        self.requests = {}
        self.closed = False
        self.revision = 0

    @staticmethod
    def state_path(book):
        return source_path(book).parent / "selection-preparation.json"

    def _saved(self, book):
        try:
            state = load(self.state_path(book), {})
            if (
                not isinstance(state, dict)
                or not isinstance(state.get("errors", {}), dict)
                or any(
                    not isinstance(key, str)
                    or not key.isdigit()
                    or not 1 <= int(key) <= book["pages"]
                    or not isinstance(value, str)
                    for key, value in state.get("errors", {}).items()
                )
            ):
                return {}
            return (
                state
                if state.get("fingerprint") == selection_directory(book).name
                else {}
            )
        except (OSError, ValueError, AttributeError):
            return {}

    def status(self, book):
        ready = prepared_pages(book)
        with self.condition:
            state = self.jobs.get(book["id"]) or self._saved(book)
        errors = {
            key: value
            for key, value in state.get("errors", {}).items()
            if int(key) not in ready
        }
        status = state.get("status", "idle")
        if len(ready) == book["pages"]:
            status = "ready"
        with self.condition:
            active = (
                self.active[1] if self.active and self.active[0] == book["id"] else None
            )
            if self.foreground_active and self.foreground_active[0] == book["id"]:
                active = self.foreground_active[1]
        return {
            "status": status,
            "completed": len(ready),
            "total": book["pages"],
            "preparedPages": ready,
            "failedPages": sorted(int(page) for page in errors),
            "error": state.get("storageError") or next(iter(errors.values()), ""),
            "activePage": active,
        }

    def _start_thread(self):
        if self.thread is None:
            self.thread = threading.Thread(
                target=self._run, daemon=True, name="pdf-preparation"
            )
            self.thread.start()
        self.condition.notify_all()

    def nearby(self, book, page, client):
        with self.condition:
            self.sequence += 1
            pages = [
                number
                for number in [page, page + 1, page + 2, page + 3, page - 1]
                if 1 <= number <= book["pages"]
            ]
            self.clients[client] = (book["id"], pages, self.sequence)
            self.revision = time.time_ns()
            while len(self.clients) > 16:
                oldest = min(self.clients, key=lambda key: self.clients[key][2])
                del self.clients[oldest]
            self._start_thread()

    def leave(self, client):
        with self.condition:
            self.clients.pop(client, None)
            self.revision = time.time_ns()
            for key, request in list(self.requests.items()):
                request["clients"].discard(client)
                if not request["clients"]:
                    self.requests.pop(key)
                    request["future"].set_exception(
                        ValueError("阅读窗口已离开，当前页可在重新打开后准备。")
                    )
            self.condition.notify_all()

    def foreground(self, book, page, client=""):
        saved = saved_selection(book, page)
        if saved and not saved.get("native"):
            return saved
        key = (book["id"], selection_directory(book).name, page)
        with self.condition:
            self.sequence += 1
            request = self.requests.get(key)
            if request is None:
                request = {
                    "book": book,
                    "page": page,
                    "future": Future(),
                    "clients": set(),
                }
                self.requests[key] = request
            request["sequence"] = self.sequence
            request["clients"].add(client)
            self.revision = time.time_ns()
            while len(self.requests) > 16:
                oldest = min(
                    self.requests, key=lambda item: self.requests[item]["sequence"]
                )
                removed = self.requests.pop(oldest)
                removed["future"].set_exception(
                    ValueError("准备请求已让位于当前阅读页，请重试。")
                )
            if self.foreground_thread is None:
                self.foreground_thread = threading.Thread(
                    target=self._run_foreground, daemon=True, name="pdf-current-page"
                )
                self.foreground_thread.start()
            self.condition.notify_all()
        try:
            return request["future"].result(timeout=240)
        except TimeoutError:
            with self.condition:
                if self.requests.get(key) is request:
                    self.requests.pop(key)
            raise ValueError("本页文字准备超时，已完成页保留，可重试。") from None

    def _run_foreground(self):
        while True:
            with self.condition:
                if self.closed:
                    return
                if not self.requests:
                    self.foreground_active = None
                    self.condition.wait()
                    continue
                key = max(
                    self.requests, key=lambda item: self.requests[item]["sequence"]
                )
                request = self.requests.pop(key)
                book, page = request["book"], request["page"]
                self.foreground_active = (book["id"], page)
            try:
                request["future"].set_result(self.foreground_processor(book, page))
            except Exception as error:
                request["future"].set_exception(error)
            with self.condition:
                self.foreground_active = None
                self.revision = time.time_ns()
                self.condition.notify_all()

    def start(self, book, *, resume=False):
        with self.condition:
            state = self._saved(book)
            if (
                book["id"] not in self.jobs
                or self.jobs[book["id"]].get("status") != "running"
            ):
                state = {
                    "fingerprint": selection_directory(book).name,
                    "status": "running",
                    "errors": state.get("errors", {}) if resume else {},
                }
                save(self.state_path(book), state)
                self.jobs[book["id"]] = state
                self.revision = time.time_ns()
                self.failed_nearby = {
                    entry for entry in self.failed_nearby if entry[0] != book["id"]
                }
            self._start_thread()
        return self.status(book)

    def pause(self, book):
        with self.condition:
            state = self.jobs.pop(book["id"], None) or self._saved(book)
            state.update(fingerprint=selection_directory(book).name, status="paused")
            save(self.state_path(book), state)
            self.revision = time.time_ns()
            self.condition.notify_all()
        return self.status(book)

    def restore(self, books):
        for book in books:
            if book.get("type") != "pdf":
                continue
            try:
                if self._saved(book).get("status") == "running":
                    if book.get("parseEnabled"):
                        self.start(book, resume=True)
                    else:
                        self.pause(book)
            except (OSError, ValueError):
                continue

    def _pick(self):
        choices, known = [], {}

        def book_state(ident):
            if ident not in known:
                book = self.get_book(ident)
                known[ident] = (
                    (book, set(prepared_pages(book)))
                    if book and book.get("parseEnabled")
                    else (None, set())
                )
            return known[ident]

        for client, (ident, pages, sequence) in list(self.clients.items()):
            book, ready = book_state(ident)
            if not book:
                del self.clients[client]
                continue
            for order, page in enumerate(pages):
                if self.foreground_active == (ident, page) or any(
                    key[0] == ident and key[2] == page for key in self.requests
                ):
                    continue
                if page not in ready and (ident, page) not in self.failed_nearby:
                    choices.append(
                        (0 if order == 0 else 1, -sequence, order, book, page)
                    )
                    break
        for ident, state in list(self.jobs.items()):
            if state["status"] != "running":
                continue
            book, ready = book_state(ident)
            if not book:
                if self.get_book(ident):
                    self.pause(self.get_book(ident))
                else:
                    self.jobs.pop(ident, None)
                continue
            if state["fingerprint"] != selection_directory(book).name:
                self.pause(book)
                continue
            missing = [
                page
                for page in range(1, book["pages"] + 1)
                if page not in ready and str(page) not in state["errors"]
            ]
            if missing:
                choices.append((2, 0, 0, book, missing[0]))
            else:
                state["status"] = "error" if len(ready) < book["pages"] else "ready"
                save(self.state_path(book), state)
                self.jobs.pop(ident, None)
        return min(choices, key=lambda item: item[:3])[3:] if choices else None

    def _run(self):
        while True:
            with self.condition:
                if self.closed:
                    return
                try:
                    choice = self._pick()
                except (OSError, ValueError):
                    choice = None
                if choice is None:
                    self.active = None
                    self.condition.wait()
                    continue
                book, page = choice
                self.active = (book["id"], page)
            error = None
            try:
                self.processor(book, page)
            except Exception as exception:
                error = (
                    str(exception)
                    if isinstance(exception, ValueError)
                    else "本页文字准备失败，可稍后重试。"
                )
            with self.condition:
                self.active = None
                self.revision = time.time_ns()
                state = self.jobs.get(book["id"])
                if error:
                    self.failed_nearby.add((book["id"], page))
                    if state:
                        state["errors"][str(page)] = error
                elif state:
                    state["errors"].pop(str(page), None)
                if state:
                    try:
                        save(self.state_path(book), state)
                    except OSError:
                        state.update(
                            status="error",
                            storageError="准备记录暂时无法保存，请检查本机存储后重试。",
                        )

    def close(self):
        with self.condition:
            self.closed = True
            for request in self.requests.values():
                request["future"].set_exception(ValueError("文字准备已停止。"))
            self.requests.clear()
            self.condition.notify_all()
        if self.thread:
            self.thread.join(timeout=5)
        if self.foreground_thread:
            self.foreground_thread.join(timeout=5)
