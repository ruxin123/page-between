import json
import sys
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import book_import
import chapter_edit
import server
from pdf_selection import utf16
from storage import load, save


class ChapterEdits(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.override = patch.object(book_import, "BOOK_ROOT", self.root / "books")
        self.override.start()
        self.source = self.root / "sample.txt"
        self.source.write_text(
            "第一章开端\n\nA😀第一段。\n\nB第二段。\n\n第二章继续\n\nC第三段。"
        )
        self.book = book_import.import_book(self.source)
        self.original = book_import.path_for(self.book["originalUrl"]).read_bytes()

    def tearDown(self):
        self.override.stop()
        self.temp.cleanup()

    def apply(self, payload):
        self.book.update(chapter_edit.stage(self.book, payload))
        chapter_edit.cleanup(self.book)
        return load(book_import.path_for(self.book["contentUrl"]), [])

    def test_split_merge_and_undo_preserve_original_offsets_and_emoji(self):
        initial = load(book_import.path_for(self.book["contentUrl"]), [])
        offset = initial[0]["sourceOffset"] + utf16(initial[0]["body"].split("B")[0])
        chapters = self.apply(
            {"action": "split", "index": 1, "offset": offset, "title": "手工起点"}
        )
        self.assertEqual(len(chapters), 3)
        self.assertEqual(chapters[1]["sourceOffset"], offset)
        self.assertIn("😀", chapters[0]["body"])
        merged = self.apply({"action": "merge", "index": 2})
        self.assertEqual(merged[0]["body"], initial[0]["body"])
        undone = self.apply({"action": "undo"})
        self.assertEqual(len(undone), 3)
        self.assertEqual(undone[1]["title"], "手工起点")
        self.assertEqual(undone[1]["sourceOffset"], offset)
        self.assertEqual(
            book_import.path_for(self.book["originalUrl"]).read_bytes(), self.original
        )
        self.assertIsInstance(self.book["structureRevision"], str)

    def test_automatic_reset_can_be_undone_and_old_versions_are_bounded(self):
        for index in range(8):
            self.apply(
                {"action": "rename", "index": 1, "title": "手工标题 " + str(index)}
            )
        directory = book_import.path_for(self.book["contentUrl"]).parent
        self.assertLessEqual(len(list(directory.glob("text-*.json"))), 2)
        reset = self.apply({"action": "reset"})
        self.assertEqual(reset[0]["title"], "第一章开端")
        self.assertFalse(self.book["manualContents"])
        self.apply({"action": "undo"})
        self.assertEqual(self.book["chapters"][0]["title"], "手工标题 7")
        self.assertTrue(self.book["customContentsUrl"])

    def test_invalid_boundary_or_title_does_not_publish_new_content(self):
        initial = load(book_import.path_for(self.book["contentUrl"]), [])
        directory = book_import.path_for(self.book["contentUrl"]).parent
        before = list(directory.iterdir())
        for payload in (
            {
                "action": "split",
                "index": 1,
                "offset": initial[0]["sourceOffset"] + 2,
                "title": "半个字符",
            },
            {"action": "rename", "index": True, "title": "无效"},
            {"action": "rename", "index": 1, "title": "长" * 121},
            {"action": "merge", "index": 1},
        ):
            with self.assertRaises(ValueError):
                chapter_edit.stage(self.book, payload)
        self.assertEqual(list(directory.iterdir()), before)
        self.assertEqual(
            load(book_import.path_for(self.book["contentUrl"]), []), initial
        )

    def test_disabling_and_enabling_navigation_retains_manual_contents(self):
        chapters = self.apply(
            {"action": "rename", "index": 1, "title": "保留的手工标题"}
        )
        with (
            patch.object(server, "DATA", self.root),
            patch.object(server, "BOOK_ROOT", self.root / "books"),
            patch.object(server, "RUNNING", set()),
            patch.object(server, "CANCELS", {}),
            patch.object(server.WORKERS, "submit") as submit,
        ):
            save(self.root / "library.json", {"books": [self.book], "jobs": []})
            manual_url = self.book["contentUrl"]
            for enabled in (False, True):
                server.update_book(self.book["id"], {"parseEnabled": enabled})
                server.start_job(self.book["id"])
                submit.call_args[0][0]()
                book = server.book_for(self.book["id"])
                self.assertEqual(book["processing"], "ready")
                self.assertEqual(book["manualContents"], enabled)
                self.assertEqual(book["customContentsUrl"], manual_url)
                self.assertTrue(book_import.path_for(manual_url).is_file())
                self.assertEqual(len(book["chapters"]), len(chapters) if enabled else 1)
            self.assertEqual(book["chapters"][0]["title"], "保留的手工标题")
            self.assertEqual(book["contentUrl"], manual_url)

    def test_failed_catalog_save_keeps_previous_content_authoritative(self):
        with (
            patch.object(server, "DATA", self.root),
            patch.object(server, "BOOK_ROOT", self.root / "books"),
        ):
            save(self.root / "library.json", {"books": [self.book], "jobs": []})
            previous = load(self.root / "library.json", {})
            update = chapter_edit.stage(
                self.book, {"action": "rename", "index": 1, "title": "未发布的标题"}
            )

            def fail_catalog(path, value):
                if path == self.root / "library.json":
                    raise OSError("synthetic disk failure")
                save(path, value)

            with (
                patch.object(server, "save", side_effect=fail_catalog),
                self.assertRaises(OSError),
            ):
                server.update_book(self.book["id"], update)
            self.assertEqual(load(self.root / "library.json", {}), previous)
            self.assertTrue(book_import.path_for(self.book["contentUrl"]).is_file())
            self.assertEqual(
                book_import.path_for(self.book["originalUrl"]).read_bytes(),
                self.original,
            )

    def test_http_rejects_stale_chapter_revision_from_another_window(self):
        with (
            patch.object(server, "DATA", self.root),
            patch.object(server, "BOOK_ROOT", self.root / "books"),
            patch.object(server, "RUNNING", set()),
        ):
            save(self.root / "library.json", {"books": [self.book], "jobs": []})
            http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
            worker = threading.Thread(target=http.serve_forever, daemon=True)
            worker.start()
            connection = HTTPConnection("127.0.0.1", http.server_port)
            try:
                for expected in (200, 409):
                    connection.request(
                        "POST",
                        f"/api/books/{self.book['id']}/chapters",
                        json.dumps(
                            {
                                "action": "rename",
                                "index": 1,
                                "revision": "",
                                "title": "另一窗口更新",
                            }
                        ),
                        {"Content-Type": "application/json"},
                    )
                    response = connection.getresponse()
                    self.assertEqual(response.status, expected)
                    response.read()
                self.assertEqual(
                    server.book_for(self.book["id"])["chapters"][0]["title"],
                    "另一窗口更新",
                )
            finally:
                connection.close()
                http.shutdown()
                http.server_close()
                worker.join()


if __name__ == "__main__":
    unittest.main()
