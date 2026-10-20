import json
import hashlib
import socket
import sys
import tempfile
import threading
import unittest
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import book_import
import server
import storage
from paths import DATA_PREFIX
from scripts.migrate_library import migrate


class AppStorage(unittest.TestCase):
    def test_large_import_streams_to_disk_and_truncated_upload_leaves_no_book(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = ("第一章 开始\n\n" + "read locally.\n" * 160000).encode()
            with (
                patch.object(server, "DATA", root),
                patch.object(server, "BOOK_ROOT", root / "books"),
                patch.object(book_import, "BOOK_ROOT", root / "books"),
                patch.object(server, "SESSION", ""),
                patch.object(
                    server.Handler,
                    "request_body",
                    side_effect=AssertionError("raw uploads must stream"),
                ),
            ):
                http = server.ReaderServer(("127.0.0.1", 0), server.Handler)
                worker = threading.Thread(target=http.serve_forever, daemon=True)
                worker.start()
                try:
                    connection = HTTPConnection("127.0.0.1", http.server_port)
                    connection.request(
                        "POST",
                        "/api/import?name=large.txt&parse=0",
                        payload,
                        {"Content-Type": "application/octet-stream"},
                    )
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    book = json.loads(response.read())["book"]
                    self.assertEqual(
                        book["sourceHash"], hashlib.sha256(payload).hexdigest()
                    )
                    self.assertEqual(
                        (root / "books" / book["id"] / "original.txt").read_bytes(),
                        payload,
                    )
                    connection.close()
                    connection = HTTPConnection("127.0.0.1", http.server_port)
                    connection.putrequest(
                        "POST", "/api/import?name=partial.txt&parse=0"
                    )
                    connection.putheader("Content-Length", "12")
                    connection.endheaders()
                    connection.send(b"abc")
                    connection.sock.shutdown(socket.SHUT_WR)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 400)
                    response.read()
                    connection.close()
                    self.assertEqual(len(server.library()["books"]), 1)
                    self.assertFalse(list((root / "incoming").iterdir()))
                finally:
                    http.shutdown()
                    http.server_close()
                    worker.join()

    def test_epub_import_outside_source_handles_macos_temporary_directory_aliases(self):
        from scripts.create_demo import make_epub

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_epub(root / "sample.epub")
            with patch.object(book_import, "BOOK_ROOT", root / "books"):
                book = book_import.import_book(root / "sample.epub")
                self.assertTrue(
                    book_import.path_for(book["chapters"][0]["url"]).is_file()
                )

    def test_desktop_session_is_required_and_never_returned_in_json(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            storage.save(data / "state.json", {"revision": 1})
            token = "syntheticSessionForLocalTest"
            with (
                patch.object(server, "DATA", data),
                patch.object(server, "SESSION", token),
            ):
                http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
                worker = threading.Thread(target=http.serve_forever, daemon=True)
                worker.start()
                try:
                    connection = HTTPConnection("127.0.0.1", http.server_port)
                    connection.request("GET", "/api/health")
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    response.read()
                    connection.request("GET", "/api/state")
                    response = connection.getresponse()
                    self.assertEqual(response.status, 401)
                    response.read()
                    connection.request(
                        "GET", "/api/state", headers={"X-Page-Between-Session": token}
                    )
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    cookie = response.getheader("Set-Cookie")
                    self.assertIn("HttpOnly", cookie)
                    self.assertIn("SameSite=Strict", cookie)
                    self.assertNotIn(token, response.read().decode())
                    connection.request(
                        "GET", "/api/state", headers={"Cookie": cookie.split(";")[0]}
                    )
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    response.read()
                    connection.request(
                        "POST", "/api/state", "{}", {"Content-Type": "application/json"}
                    )
                    response = connection.getresponse()
                    self.assertEqual(response.status, 401)
                    response.read()
                    connection.request(
                        "GET",
                        "/api/state",
                        headers={
                            "X-Page-Between-Session": token,
                            "Origin": "https://outside.invalid",
                        },
                    )
                    response = connection.getresponse()
                    self.assertEqual(response.status, 403)
                    response.read()
                    connection.request(
                        "GET", "/api/state", headers={"X-Page-Between-Session": "é"}
                    )
                    response = connection.getresponse()
                    self.assertEqual(response.status, 401)
                    response.read()
                    connection.close()
                finally:
                    http.shutdown()
                    http.server_close()
                    worker.join()

    def test_failed_atomic_replace_preserves_original_and_cleans_temporary(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            storage.save(path, {"version": 1})
            with patch.object(
                storage.os, "replace", side_effect=OSError("disk unavailable")
            ):
                with self.assertRaises(OSError):
                    storage.save(path, {"version": 2})
            self.assertEqual(storage.load(path, {}), {"version": 1})
            self.assertEqual(
                [item.name for item in path.parent.iterdir()], ["state.json"]
            )

    def test_library_migration_verifies_files_and_preserves_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / "old", root / "new"
            book_dir = source / "books/example"
            book_dir.mkdir(parents=True)
            (book_dir / "original.txt").write_text("第一章 开始\n正文")
            assets = root / "assets"
            assets.mkdir()
            (assets / "extra.json").write_text('{"1":{"blocks":[]}}')
            book = {
                "id": "example",
                "type": "txt",
                "title": "自编样例",
                "url": DATA_PREFIX + "/books/example/original.txt",
                "enrichmentUrl": "/assets/extra.json",
            }
            storage.save(source / "library.json", {"books": [book], "jobs": []})
            storage.save(
                source / "state.json", {"positions": {"example": {"index": 2}}}
            )
            before = (source / "library.json").read_bytes()
            report = migrate(source, target)
            self.assertEqual(report["books"], 1)
            self.assertEqual((source / "library.json").read_bytes(), before)
            migrated = storage.load(target / "library.json", {})["books"][0]
            self.assertEqual(
                migrated["enrichmentUrl"],
                DATA_PREFIX + "/books/example/enrichment.json",
            )
            self.assertTrue((target / "books/example/enrichment.json").exists())
            self.assertEqual(
                storage.load(target / "state.json", {})["positions"]["example"][
                    "index"
                ],
                2,
            )
            with self.assertRaisesRegex(ValueError, "不会覆盖"):
                migrate(source, target)
            self.assertFalse(list(root.glob(".page-between-migration-*")))

    def test_invalid_migration_never_activates_a_partial_library(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "old"
            (source / "books/example").mkdir(parents=True)
            storage.save(
                source / "library.json",
                {
                    "books": [
                        {
                            "id": "example",
                            "url": DATA_PREFIX + "/books/example/missing.pdf",
                        }
                    ]
                },
            )
            with self.assertRaisesRegex(ValueError, "缺失"):
                migrate(source, root / "new")
            self.assertFalse((root / "new").exists())
            self.assertFalse(list(root.glob(".page-between-migration-*")))

    def test_outside_source_books_serve_through_stable_urls_with_access_guards(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "Application Support/Library"
            books = data / "books"
            (books / "example").mkdir(parents=True)
            (books / "example/chapter.xhtml").write_text("<p>本机正文</p>")
            (root / ".env").write_text("PRIVATE=not-for-http")
            storage.save(data / "library.json", {"books": [{"id": "example"}]})
            storage.save(data / "state.json", {"private": True})
            with (
                patch.object(server, "DATA", data),
                patch.object(book_import, "BOOK_ROOT", books),
            ):
                http = ThreadingHTTPServer(
                    ("127.0.0.1", 0), partial(server.Handler, directory=str(root))
                )
                worker = threading.Thread(target=http.serve_forever, daemon=True)
                worker.start()
                try:
                    connection = HTTPConnection("127.0.0.1", http.server_port)
                    path = DATA_PREFIX + "/books/example/chapter.xhtml"
                    self.assertEqual(
                        book_import.path_for(
                            book_import.url_for(books / "example/chapter.xhtml")
                        ),
                        (books / "example/chapter.xhtml").resolve(),
                    )
                    connection.request("GET", path)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertIn(
                        "script-src 'none'",
                        response.getheader("Content-Security-Policy"),
                    )
                    self.assertIn("本机正文", response.read().decode())
                    for path in (
                        DATA_PREFIX + "/state.json",
                        DATA_PREFIX + "/books/example/",
                        DATA_PREFIX + "/books/unknown/chapter.xhtml",
                        "/.env",
                        "/server.py",
                        "/tmp/anything",
                        DATA_PREFIX + "/books/example/%2e%2e/%2e%2e/state.json",
                    ):
                        connection.request("GET", path)
                        response = connection.getresponse()
                        self.assertNotEqual(response.status, 200, path)
                        response.read()
                    connection.request("HEAD", "/.env")
                    response = connection.getresponse()
                    self.assertEqual(response.status, 405)
                    response.read()
                    connection.close()
                finally:
                    http.shutdown()
                    http.server_close()
                    worker.join()


if __name__ == "__main__":
    unittest.main()
