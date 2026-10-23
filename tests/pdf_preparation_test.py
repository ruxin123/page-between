import json
import os
import shutil
import tempfile
import threading
import time
import unittest
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import book_import
import pdf_enhancement as pdf
from pdf_preparation import PDFPreparation
from scripts.create_demo import make_pdf
from storage import save
import server
import library_data


def result(book, page):
    return {
        "page": page,
        "width": 200,
        "height": 300,
        "engine": "apple-vision"
        if book.get("language", "en").startswith("zh")
        else "tesseract-eng",
        "lines": [{"text": "Original prepared text", "bbox": [0.1, 0.1, 0.9, 0.2]}],
    }


class SelectionPreparation(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.patches = [
            patch.object(book_import, "BOOK_ROOT", self.root / "books"),
            patch.object(pdf, "CACHE", self.root / "old-cache"),
        ]
        for override in self.patches:
            override.start()
        source = self.root / "original.pdf"
        make_pdf(source)
        self.book = book_import.import_book(source, enabled=True)
        self.book["language"] = "en"
        self.managers = []

    def tearDown(self):
        for manager in self.managers:
            manager.close()
        for override in reversed(self.patches):
            override.stop()
        self.temporary.cleanup()

    def manager(self, processor):
        manager = PDFPreparation(
            lambda ident: self.book if ident == self.book["id"] else None, processor
        )
        self.managers.append(manager)
        return manager

    def wait(self, predicate):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.01)
        self.fail("Local preparation did not reach the expected state")

    def test_results_survive_cache_cleanup_and_invalidate_changed_source_or_language(
        self,
    ):
        with patch.object(
            pdf, "recognize_page", side_effect=lambda book, page, *_: result(book, page)
        ) as engine:
            first = pdf.recognize(self.book, 1)
            folder = pdf.selection_directory(self.book)
            shutil.rmtree(pdf.CACHE, ignore_errors=True)
            self.assertEqual(pdf.recognize(self.book, 1), first)
            self.assertEqual(engine.call_count, 1)
            self.assertTrue(
                folder.is_relative_to(book_import.BOOK_ROOT / self.book["id"])
            )
            original = book_import.path_for(self.book["url"])
            with original.open("ab") as stream:
                stream.write(b"\n% changed source bytes\n")
            pdf.recognize(self.book, 1)
            self.assertEqual(engine.call_count, 2)
            self.assertNotEqual(pdf.selection_directory(self.book), folder)
            self.book["language"] = "zh"
            pdf.recognize(self.book, 1)
            self.assertEqual(engine.call_count, 3)
            (pdf.selection_directory(self.book) / "1.json").write_text("{")
            self.assertNotIn(1, pdf.prepared_pages(self.book))
            pdf.recognize(self.book, 1)
            self.assertEqual(engine.call_count, 4)

    def test_legacy_cache_migrates_and_native_pages_need_no_ocr(self):
        legacy = pdf.CACHE / self.book["id"] / "2-full-eng.json"
        save(legacy, result(self.book, 2))
        with patch.object(
            pdf, "recognize_page", side_effect=lambda book, page, *_: result(book, page)
        ) as engine:
            self.assertEqual(pdf.prepared_pages(self.book), [2])
            self.assertEqual(pdf.recognize(self.book, 2)["engine"], "tesseract-eng")
            native = pdf.recognize(
                self.book, 1, allow_native=True, include_enrichment=False
            )
            self.assertTrue(native["native"])
            engine.assert_not_called()
            foreground = pdf.recognize(self.book, 1)
            self.assertTrue(foreground["lines"])
            self.assertNotIn("native", foreground)
            self.assertEqual(engine.call_count, 1)
        old = pdf.CACHE / self.book["id"] / "3-full-eng.json"
        save(old, result(self.book, 3))
        timestamp = book_import.path_for(self.book["url"]).stat().st_mtime - 10
        os.utime(old, (timestamp, timestamp))
        self.assertIsNone(pdf.saved_selection(self.book, 3))

    def test_whole_book_pause_preserves_inflight_page_and_reading_pages_take_priority(
        self,
    ):
        entered, release = threading.Event(), threading.Event()
        calls = []

        def process(book, page):
            calls.append(page)
            if page == 1:
                entered.set()
                self.assertTrue(release.wait(5))
            pdf.save_selection(book, page, result(book, page))

        manager = self.manager(process)
        manager.start(self.book)
        self.assertTrue(entered.wait(5))
        manager.nearby(self.book, 4, "reader")
        manager.pause(self.book)
        release.set()
        self.wait(lambda: set(pdf.prepared_pages(self.book)) == {1, 3, 4})
        self.assertEqual(calls, [1, 4, 3])
        self.assertEqual(manager.status(self.book)["status"], "paused")
        manager.leave("reader")
        manager.close()
        remaining = []
        resumed = self.manager(
            lambda book, page: (
                remaining.append(page),
                pdf.save_selection(book, page, result(book, page)),
            )
        )
        resumed.start(self.book)
        self.wait(lambda: resumed.status(self.book)["status"] == "ready")
        self.assertEqual(remaining, [2])

    def test_restart_resumes_only_missing_pages_and_retries_failures_explicitly(self):
        pdf.save_selection(self.book, 1, result(self.book, 1))
        save(
            PDFPreparation.state_path(self.book),
            {
                "fingerprint": pdf.selection_directory(self.book).name,
                "status": "running",
                "errors": {},
            },
        )
        calls, fail = [], {2}

        def process(book, page):
            calls.append(page)
            if page in fail:
                raise ValueError("Diagnostic OCR failure")
            pdf.save_selection(book, page, result(book, page))

        manager = self.manager(process)
        manager.restore([self.book])
        self.wait(lambda: manager.status(self.book)["status"] == "error")
        state = manager.status(self.book)
        self.assertEqual(state["completed"], 3)
        self.assertEqual(state["failedPages"], [2])
        self.assertEqual(calls, [2, 3, 4])
        fail.clear()
        manager.start(self.book)
        self.wait(lambda: manager.status(self.book)["status"] == "ready")
        self.assertEqual(calls, [2, 3, 4, 2])

    def test_replacing_reading_position_discards_old_pending_prefetch(self):
        entered, release = threading.Event(), threading.Event()
        calls = []

        def process(book, page):
            calls.append(page)
            if page == 1:
                entered.set()
                self.assertTrue(release.wait(5))
            pdf.save_selection(book, page, result(book, page))

        manager = self.manager(process)
        manager.nearby(self.book, 1, "reader")
        self.assertTrue(entered.wait(5))
        manager.nearby(self.book, 4, "reader")
        release.set()
        self.wait(lambda: set(pdf.prepared_pages(self.book)) == {1, 3, 4})
        self.assertEqual(calls, [1, 4, 3])

    def test_http_controls_validate_pages_and_local_preparation_runs_alongside_cloud(
        self,
    ):
        self.book["parseEnabled"] = False
        manager = PDFPreparation(
            server.book_for,
            lambda book, page: pdf.save_selection(book, page, result(book, page)),
        )
        self.managers.append(manager)
        with (
            patch.object(server, "DATA", self.root),
            patch.object(server, "BOOK_ROOT", self.root / "books"),
            patch.object(server, "PDF_PREPARATION", manager),
            patch.object(server, "RUNNING", {self.book["id"]}),
            patch.object(server, "SESSION", ""),
        ):
            save(
                self.root / "library.json",
                {
                    "books": [self.book],
                    "jobs": [
                        {
                            "book": self.book["id"],
                            "kind": "mineru",
                            "status": "running",
                            "pages": [1, 2],
                            "phase": "Diagnostic cloud task",
                        }
                    ],
                },
            )
            http = ThreadingHTTPServer(
                ("127.0.0.1", 0),
                partial(server.Handler, directory=str(book_import.ROOT)),
            )
            worker = threading.Thread(target=http.serve_forever, daemon=True)
            worker.start()

            def request(path, payload=None):
                connection = HTTPConnection("127.0.0.1", http.server_port, timeout=5)
                connection.request(
                    "POST" if payload is not None else "GET",
                    path,
                    body=json.dumps(payload) if payload is not None else None,
                    headers={"Content-Type": "application/json"},
                )
                response = connection.getresponse()
                status, body = response.status, json.loads(response.read())
                connection.close()
                return status, body

            try:
                base = {"book": self.book["id"], "client": "reader", "action": "nearby"}
                self.assertEqual(
                    request("/api/pdf/prepare", {**base, "page": True})[0], 400
                )
                self.assertEqual(
                    request("/api/pdf/prepare", {**base, "page": 9})[0], 400
                )
                self.assertEqual(
                    request(
                        "/api/pdf/prepare", {**base, "page": 1, "client": "../bad"}
                    )[0],
                    400,
                )
                self.assertFalse(
                    request("/api/pdf/prepare", {**base, "page": 1})[1]["queued"]
                )
                self.assertEqual(
                    request(
                        "/api/pdf/prepare", {"book": self.book["id"], "action": "all"}
                    )[0],
                    200,
                )
                self.wait(
                    lambda: manager.status(server.book_for(self.book["id"]))["status"]
                    == "ready"
                )
                status, body = request("/api/pdf/preparation?book=" + self.book["id"])
                self.assertEqual(status, 200)
                self.assertEqual(body["local"]["completed"], 4)
                self.assertEqual(body["mineru"]["status"], "running")
                self.assertTrue(server.book_for(self.book["id"])["parseEnabled"])
                self.assertIn(self.book["id"], server.RUNNING)
                self.assertEqual(
                    request(
                        "/api/pdf/prepare", {"action": "leave", "client": "reader"}
                    )[0],
                    200,
                )
            finally:
                manager.close()
                http.shutdown()
                http.server_close()
                worker.join()

    def test_current_page_requests_take_priority_and_reuse_saved_geometry(self):
        entered, release = threading.Event(), threading.Event()
        calls = []

        def foreground(book, page):
            calls.append(page)
            if page == 1:
                entered.set()
                self.assertTrue(release.wait(5))
            return pdf.save_selection(book, page, result(book, page))

        manager = PDFPreparation(
            lambda ident: self.book, foreground_processor=foreground
        )
        self.managers.append(manager)
        with ThreadPoolExecutor(max_workers=3) as readers:
            first = readers.submit(manager.foreground, self.book, 1, "reader")
            self.assertTrue(entered.wait(5))
            older = readers.submit(manager.foreground, self.book, 2, "reader")
            self.wait(lambda: len(manager.requests) == 1)
            current = readers.submit(manager.foreground, self.book, 4, "reader")
            self.wait(lambda: len(manager.requests) == 2)
            release.set()
            for response in (first, older, current):
                self.assertTrue(response.result(timeout=5)["lines"])
        self.assertEqual(calls, [1, 4, 2])
        self.assertEqual(manager.foreground(self.book, 4, "reader")["page"], 4)
        self.assertEqual(calls, [1, 4, 2])

    def test_cache_cleanup_migrates_old_full_results_before_removing_temporary_files(
        self,
    ):
        cache = self.root / "Cache"
        with (
            patch.object(pdf, "CACHE", cache / "ocr-v4"),
            patch.object(library_data, "CACHE", cache),
            patch.object(library_data, "DATA", self.root),
        ):
            save(pdf.CACHE / self.book["id"] / "1-full-eng.json", result(self.book, 1))
            save(self.root / "library.json", {"books": [self.book], "jobs": []})
            library_data.queue_cache_cleanup()
            library_data.apply_cache_cleanup()
            self.assertFalse(pdf.CACHE.exists())
            self.assertEqual(pdf.prepared_pages(self.book), [1])
            with patch.object(
                pdf,
                "recognize_page",
                side_effect=AssertionError("Migrated text was lost"),
            ):
                self.assertTrue(pdf.recognize(self.book, 1)["lines"])


if __name__ == "__main__":
    unittest.main()
