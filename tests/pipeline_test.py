import json
import sys
import tempfile
import threading
import unittest
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
import book_import
from pdf_enhancement import (
    hocr_lines,
    joined_rows,
    toc_entries,
    printed_number,
    tree_from_entries,
)


def line(text, x, y, right=0.9):
    return {"text": text, "bbox": [x, y, right, y + 0.02]}


class Contents(unittest.TestCase):
    def test_character_boxes_preserve_word_spaces_and_line_order(self):
        source = """<html xmlns="http://www.w3.org/1999/xhtml"><body>
        <span class="ocr_line" title="bbox 10 20 85 40; baseline 0 0">
          <span class="ocrx_word" title="bbox 10 20 25 40">
            <span class="ocrx_cinfo" title="x_bboxes 10 20 15 40; x_conf 99">i</span>
            <span class="ocrx_cinfo" title="x_bboxes 16 20 25 40; x_conf 98">f</span>
          </span><span class="ocrx_word" title="bbox 40 20 85 40">wide</span>
        </span></body></html>"""
        lines = hocr_lines(source, 100, 200)
        self.assertEqual(lines[0]["text"], "if wide")
        self.assertEqual(
            [part["text"] for part in lines[0]["segments"]], ["i", "f ", "wide "]
        )
        self.assertEqual(lines[0]["segments"][0]["bbox"], [0.1, 0.1, 0.15, 0.2])
        self.assertEqual(lines[0]["segments"][1]["bbox"], [0.16, 0.1, 0.25, 0.2])
        with self.assertRaisesRegex(ValueError, "字符坐标"):
            hocr_lines(source.replace("x_bboxes", "missing"), 100, 200)

    def test_chinese_and_english_use_the_same_page_mapping(self):
        entries = toc_entries(
            [
                line("目录", 0.4, 0.05),
                line("第一章 自然数 …… 3", 0.1, 0.2),
                line("1.1 数学归纳法 …… 5", 0.15, 0.25),
                line("Chapter II Groups ..... noisy OCR 31", 0.1, 0.3),
            ]
        )
        self.assertEqual([item["printed"] for item in entries], [3, 5, 31])
        self.assertEqual([item["level"] for item in entries], [0, 1, 0])
        tree = tree_from_entries(entries)
        self.assertEqual(tree[0]["children"][0]["title"], "1.1 数学归纳法")
        self.assertEqual(printed_number([line("24", 0.48, 0.95)]), 24)
        self.assertIsNone(printed_number([line("24", 0.48, 0.5)]))

    def test_two_column_contents_do_not_merge_neighboring_titles(self):
        lines = []
        for index in range(6):
            y = 0.2 + index * 0.05
            lines.extend(
                [
                    line(f"Section {index}", 0.08, y, 0.35),
                    line(str(index + 1), 0.46, y, 0.49),
                    line(f"Appendix {index}", 0.56, y, 0.8),
                    line(str(index + 20), 0.92, y, 0.95),
                ]
            )
        rows = joined_rows(lines)
        self.assertEqual(len(rows), 12)
        self.assertEqual(rows[0]["column"], 0)
        self.assertEqual(rows[-1]["column"], 1)
        self.assertNotIn("Appendix", rows[0]["text"])


class SharedState(unittest.TestCase):
    def test_startup_recovers_text_and_cloud_jobs_without_restarting_disabled_books(
        self,
    ):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            books = [
                {
                    "id": "text",
                    "type": "txt",
                    "parseEnabled": False,
                    "processing": "pending",
                },
                {
                    "id": "epub",
                    "type": "epub",
                    "parseEnabled": True,
                    "processing": "pending",
                },
                {
                    "id": "cloud",
                    "type": "pdf",
                    "parseEnabled": True,
                    "processing": "pending",
                },
                {
                    "id": "disabled",
                    "type": "pdf",
                    "parseEnabled": False,
                    "processing": "pending",
                },
            ]
            with (
                patch.object(server, "DATA", root),
                patch.object(server, "BOOK_ROOT", root / "books"),
                patch.object(server, "start_job") as start,
            ):
                server.save(
                    root / "library.json",
                    {
                        "books": books,
                        "jobs": [
                            {
                                "book": "cloud",
                                "kind": "mineru",
                                "pages": [2, 3],
                                "resetId": "operation",
                            }
                        ],
                    },
                )
                server.resume_pending_jobs()
                self.assertEqual(start.call_count, 3)
                self.assertEqual(
                    start.call_args_list[-1].kwargs,
                    {"kind": "mineru", "pages": [2, 3], "fresh": "operation"},
                )
                self.assertEqual(server.book_for("disabled")["processing"], "ready")

    def test_cloud_job_pause_and_resume_preserve_kind_and_operation_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            queued = []
            book = {
                "id": "example",
                "title": "自编样例",
                "type": "pdf",
                "pages": 4,
                "parseEnabled": True,
            }
            with (
                patch.object(server, "DATA", root),
                patch.object(server, "BOOK_ROOT", root / "books"),
                patch.object(server, "RUNNING", set()),
                patch.object(server, "CANCELS", {}),
                patch.object(server.WORKERS, "submit", side_effect=queued.append),
            ):
                server.save(root / "library.json", {"books": [book], "jobs": []})

                def parse(book, pages, phase, cancel, **options):
                    phase("云端处理中")
                    return {
                        "processingNote": "已增强 2 页",
                        "enhancedPages": [1, 2],
                        "enhancementRevision": 10,
                    }

                with patch.object(
                    server.mineru_api, "run", side_effect=parse
                ) as parser:
                    self.assertTrue(
                        server.start_job(
                            "example", kind="mineru", pages=[1, 2], fresh="operation-id"
                        )
                    )
                    self.assertFalse(
                        server.start_job("example", kind="mineru", pages=[1, 2])
                    )
                    server.CANCELS["example"].set()
                    queued.pop(0)()
                    self.assertEqual(server.library()["jobs"][0]["status"], "paused")
                    self.assertEqual(server.book_for("example")["processing"], "ready")
                    self.assertFalse(server.RUNNING)
                    server.start_job(
                        "example", kind="mineru", pages=[1, 2], fresh="operation-id"
                    )
                    queued.pop(0)()
                    self.assertEqual(parser.call_args.kwargs["fresh"], "operation-id")
                    self.assertEqual(server.library()["jobs"][0]["status"], "ready")
                    self.assertEqual(
                        server.book_for("example")["enhancedPages"], [1, 2]
                    )
                    self.assertFalse(server.CANCELS)

    def test_saving_unchanged_parse_switch_does_not_start_another_job(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with (
                patch.object(server, "DATA", root),
                patch.object(server, "BOOK_ROOT", root / "books"),
                patch.object(server, "start_job") as start,
            ):
                server.save(
                    root / "library.json",
                    {
                        "books": [
                            {
                                "id": "example",
                                "title": "自编样例",
                                "type": "pdf",
                                "pages": 4,
                                "parseEnabled": True,
                            }
                        ],
                        "jobs": [],
                    },
                )
                http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
                worker = threading.Thread(target=http.serve_forever, daemon=True)
                worker.start()
                connection = HTTPConnection("127.0.0.1", http.server_port)
                try:
                    for payload in (
                        {"parseEnabled": True},
                        {"parseEnabled": True, "reparse": True},
                    ):
                        connection.request(
                            "POST",
                            "/api/books/example",
                            json.dumps(payload),
                            {"Content-Type": "application/json"},
                        )
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        response.read()
                        self.assertEqual(
                            start.call_count, 1 if payload.get("reparse") else 0
                        )
                finally:
                    connection.close()
                    http.shutdown()
                    http.server_close()
                    worker.join()

    def test_failed_job_retry_replaces_history_and_returns_book_to_ready(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            queued = []
            with (
                patch.object(server, "DATA", root),
                patch.object(server, "BOOK_ROOT", root / "books"),
                patch.object(server, "RUNNING", set()),
                patch.object(server.WORKERS, "submit", side_effect=queued.append),
                patch.object(
                    server,
                    "build_contents",
                    side_effect=[
                        RuntimeError("示例失败"),
                        {"processing": "ready", "processingNote": "示例重试成功"},
                    ],
                ),
            ):
                server.save(
                    root / "library.json",
                    {
                        "books": [
                            {
                                "id": "a",
                                "title": "示例",
                                "type": "pdf",
                                "parseEnabled": True,
                            }
                        ],
                        "jobs": [],
                    },
                )
                server.start_job("a")
                self.assertEqual(server.book_for("a")["processing"], "pending")
                queued.pop()()
                self.assertEqual(server.book_for("a")["processing"], "error")
                server.start_job("a")
                self.assertEqual(len(server.library()["jobs"]), 1)
                queued.pop()()
                self.assertEqual(server.book_for("a")["processing"], "ready")
                self.assertEqual(server.library()["jobs"][0]["status"], "ready")
                self.assertFalse(server.RUNNING)
                server.start_job("a")
                server.update_book("a", {"parseEnabled": False})
                queued.pop()()
                self.assertEqual(server.book_for("a")["processing"], "ready")
                self.assertEqual(server.library()["jobs"][0]["status"], "ready")

    def test_palm_launch_reuses_starting_window_and_discards_old_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "runtime/页间掌上阅读.app/Contents/MacOS/page-between-palm"
            binary.parent.mkdir(parents=True)
            binary.touch()
            with (
                patch.object(server, "DATA", root),
                patch.object(server, "RUNTIME", root / "runtime"),
                patch.object(
                    server.subprocess, "Popen", return_value=SimpleNamespace(pid=12345)
                ) as launch,
                patch.object(server.os, "kill"),
            ):
                server.save(
                    root / "library.json",
                    {
                        "books": [
                            {"id": "a", "type": "txt"},
                            {"id": "b", "type": "epub"},
                        ],
                        "jobs": [],
                    },
                )
                server.save(
                    root / "palm-command.json",
                    {"nonce": "old", "url": "http://127.0.0.1/old"},
                )
                http = ThreadingHTTPServer(
                    ("127.0.0.1", 0), partial(server.Handler, directory=directory)
                )
                worker = threading.Thread(target=http.serve_forever, daemon=True)
                worker.start()
                connection = HTTPConnection("127.0.0.1", http.server_port)

                def open_book(ident):
                    connection.request(
                        "POST",
                        "/api/palm",
                        json.dumps({"book": ident}),
                        {"Content-Type": "application/json"},
                    )
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    return json.loads(response.read())

                try:
                    open_book("a")
                    self.assertFalse((root / "palm-command.json").exists())
                    self.assertTrue(open_book("b")["reused"])
                    self.assertEqual(launch.call_count, 1)
                    self.assertTrue(
                        server.load(root / "palm-command.json", {})["url"].endswith(
                            "book=b"
                        )
                    )
                    server.save(
                        root / "palm-window.json", {"visible": False, "pid": 12345}
                    )
                    open_book("a")
                    self.assertEqual(launch.call_count, 2)
                    self.assertFalse((root / "palm-command.json").exists())
                finally:
                    connection.close()
                    http.shutdown()
                    http.server_close()
                    worker.join()

    def test_reimport_does_not_rewrite_existing_book_contents(self):
        with tempfile.TemporaryDirectory(
            dir=book_import.ROOT / "tmp", ignore_cleanup_errors=True
        ) as directory:
            root = Path(directory)
            with (
                patch.object(server, "DATA", root),
                patch.object(book_import, "BOOK_ROOT", root / "books"),
                patch.object(server, "start_job"),
                patch.object(
                    server, "import_book", wraps=book_import.import_book
                ) as importer,
            ):
                server.save(root / "library.json", {"books": [], "jobs": []})
                http = ThreadingHTTPServer(
                    ("127.0.0.1", 0), partial(server.Handler, directory=directory)
                )
                worker = threading.Thread(target=http.serve_forever, daemon=True)
                worker.start()
                connection = HTTPConnection("127.0.0.1", http.server_port)
                try:
                    for enabled in [1, 0]:
                        connection.request(
                            "POST",
                            f"/api/import?name=sample.txt&parse={enabled}",
                            "第一章 开始\n正文\n第二章 出发\n正文二".encode(),
                            {"Content-Type": "application/octet-stream"},
                        )
                        response = connection.getresponse()
                        result = json.loads(response.read())
                        self.assertEqual(response.status, 200)
                        self.assertTrue(result["book"]["parseEnabled"])
                    self.assertTrue(result["duplicate"])
                    self.assertEqual(importer.call_count, 1)
                    self.assertEqual(len(result["book"]["chapters"]), 2)
                    content = book_import.path_for(result["book"]["contentUrl"])
                    self.assertEqual(len(json.loads(content.read_text())), 2)
                finally:
                    connection.close()
                    http.shutdown()
                    http.server_close()
                    worker.join()

    def test_bookmark_location_boundaries(self):
        types = {"t": "txt", "e": "epub", "p": "pdf"}

        def same(book, a, b):
            return server.same_bookmark_place(
                {"book": book, "position": a}, {"book": book, "position": b}, types
            )

        text = {"index": 1, "sourceOffset": 100}
        self.assertTrue(same("t", text, {**text, "sourceOffset": 119}))
        self.assertFalse(same("t", text, {**text, "sourceOffset": 120}))
        self.assertFalse(same("t", text, {**text, "resource": "note"}))
        epub = {"index": 2, "anchor": {"sourceNode": 3, "charOffset": 40}}
        self.assertFalse(same("e", epub, {**epub, "anchor": {"sourceNode": 4, "charOffset": 40}}))
        self.assertFalse(same("e", epub, {**epub, "index": 3}))
        pdf = {"index": 2, "pdfY": .2}
        self.assertFalse(same("p", pdf, {**pdf, "index": 3}))
        self.assertFalse(same("p", pdf, {**pdf, "pdfY": .3}))

    def test_stale_windows_cannot_overwrite_newer_positions_or_bookmarks(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(server, "DATA", Path(directory)),
        ):
            http = ThreadingHTTPServer(
                ("127.0.0.1", 0), partial(server.Handler, directory=directory)
            )
            worker = threading.Thread(target=http.serve_forever, daemon=True)
            worker.start()
            connection = HTTPConnection("127.0.0.1", http.server_port)

            def post(value, origin=None):
                headers = {"Content-Type": "application/json"}
                if origin:
                    headers["Origin"] = origin
                connection.request("POST", "/api/state", json.dumps(value), headers)
                response = connection.getresponse()
                data = json.loads(response.read())
                return response.status, data

            try:
                status, state = post(
                    {
                        "positions": {"book": {"index": 3, "updatedAt": 20}},
                        "bookmarkChanges": {"add": [{"id": "a"}]},
                        "prefs": {"textMode": "pages"},
                    }
                )
                self.assertEqual(status, 200)
                _, state = post(
                    {
                        "positions": {"book": {"index": 1, "updatedAt": 10}},
                        "bookmarkChanges": {"add": [{"id": "a"}, {"id": "b"}]},
                        "prefs": {"theme": "night"},
                    }
                )
                self.assertEqual(state["positions"]["book"]["index"], 3)
                self.assertEqual(len(state["bookmarks"]), 2)
                self.assertEqual(
                    state["prefs"], {"textMode": "pages", "theme": "night"}
                )
                self.assertEqual(
                    post({"prefs": {}}, "https://unrelated.example")[0], 403
                )
                server.save(
                    Path(directory) / "library.json",
                    {"books": [{"id": "text", "type": "txt"}, {"id": "pdf", "type": "pdf"}], "jobs": []},
                )
                first = {"id": "window-one", "book": "text", "position": {"index": 1, "sourceOffset": 120}}
                second = {**first, "id": "window-two"}
                post({"bookmarks": [], "bookmarkChanges": {"add": [first]}})
                _, state = post({"bookmarkChanges": {"add": [second]}})
                self.assertEqual([m["id"] for m in state["bookmarks"]], ["window-one"])
                # Same PDF content point at two zoom levels is one location.
                pdf = {"id": "pdf-one", "book": "pdf", "position": {"index": 2, "top": 100, "pdfY": .2}}
                _, state = post({"bookmarkChanges": {"add": [pdf, {**pdf, "id": "pdf-two", "position": {**pdf["position"], "top": 200}}]}})
                self.assertEqual(len(state["bookmarks"]), 2)
                # Existing duplicates are removed together; distinct positions survive.
                post({"bookmarks": [first, second, {**first, "id": "other-place", "position": {"index": 2, "sourceOffset": 200}}]})
                _, state = post({"bookmarkChanges": {"remove": [first["id"]]}})
                self.assertEqual([m["id"] for m in state["bookmarks"]], ["other-place"])
            finally:
                connection.close()
                http.shutdown()
                http.server_close()
                worker.join()


if __name__ == "__main__":
    unittest.main()
