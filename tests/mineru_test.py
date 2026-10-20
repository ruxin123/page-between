import io
import json
import shutil
import sys
import tempfile
import threading
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import book_import
import mineru_api as mineru
from scripts.create_demo import make_pdf


def layout():
    return {
        "pdf_info": [
            {
                "page_idx": index,
                "page_size": [200, 300],
                "para_blocks": [
                    {
                        "type": "text",
                        "bbox": [20, 30, 180, 70],
                        "lines": [
                            {
                                "spans": [
                                    {
                                        "type": "text",
                                        "content": "A function has one output.",
                                    }
                                ]
                            }
                        ],
                    },
                    {
                        "type": "interline_equation",
                        "bbox": [50, 100, 150, 130],
                        "lines": [
                            {
                                "spans": [
                                    {
                                        "type": "interline_equation",
                                        "content": "f(x)=x^2",
                                    }
                                ]
                            }
                        ],
                    },
                    {
                        "type": "image",
                        "bbox": [20, 150, 100, 220],
                        "blocks": [
                            {
                                "type": "image_caption",
                                "lines": [
                                    {"spans": [{"type": "text", "content": "Figure 1"}]}
                                ],
                            }
                        ],
                    },
                ],
            }
            for index in range(2)
        ]
    }


class MinerU(unittest.TestCase):
    def test_page_ranges_geometry_and_untrusted_resource_addresses(self):
        self.assertEqual(
            mineru.table_text(
                "<table><tr><th>x</th><th>f(x)</th></tr><tr><td>2</td><td>4</td></tr></table>"
            ),
            "x\tf(x)\n2\t4",
        )
        self.assertEqual(mineru.page_range("2,4-6，5", 10), [2, 4, 5, 6])
        for value in ("", "0", "4-2", "2-11", "3;4"):
            with self.assertRaises(mineru.MinerUError):
                mineru.page_range(value, 10)
        pages = mineru.normalized_pages(layout(), [27, 32])
        self.assertEqual(set(pages), {"27", "32"})
        self.assertEqual(pages["27"]["blocks"][1]["type"], "equation")
        self.assertEqual(pages["27"]["blocks"][1]["text"], "f(x)=x^2")
        self.assertEqual(
            pages["27"]["blocks"][1]["bbox"], [0.25, 1 / 3, 0.75, 130 / 300]
        )
        for address in (
            "http://mineru.net/file",
            "https://mineru.net.evil.invalid/file",
            "https://user:password@mineru.net/file",
            "https://127.0.0.1/file",
            "https://mineru.net:bad/file",
        ):
            with self.assertRaises(mineru.MinerUError):
                mineru.resource_address(address, "https://mineru.net/api/v4")
        invalid = layout()
        invalid["pdf_info"][0]["page_size"] = [float("nan"), 300]
        with self.assertRaises(mineru.MinerUError):
            mineru.normalized_pages(invalid, [1, 2])

    def test_upload_pause_resume_and_cached_result_without_credentials_on_disk(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / "sample.pdf"
            make_pdf(source)
            counts = {"created": 0, "queried": 0, "uploads": 0, "downloads": 0}
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w") as archive:
                archive.writestr("layout.json", json.dumps(layout()))
            result_zip = stream.getvalue()

            class Service(BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass

                def respond(self, data):
                    body = json.dumps({"code": 0, "data": data}).encode()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

                def do_POST(self):
                    self.server.owner.assertEqual(
                        self.headers.get("Authorization"), "Bearer fixture-credential"
                    )
                    body = json.loads(
                        self.rfile.read(int(self.headers["Content-Length"]))
                    )
                    self.server.owner.assertEqual(
                        body["files"][0]["name"], "page-between-pages.pdf"
                    )
                    counts["created"] += 1
                    self.respond(
                        {
                            "batch_id": "fixture-batch",
                            "file_urls": [
                                f"http://127.0.0.1:{self.server.server_port}/upload?signature=temporary-fixture"
                            ],
                        }
                    )

                def do_PUT(self):
                    self.server.owner.assertIsNone(self.headers.get("Authorization"))
                    self.server.owner.assertIsNone(self.headers.get("Content-Type"))
                    body = self.rfile.read(int(self.headers["Content-Length"]))
                    pdf = __import__("pypdf").PdfReader(io.BytesIO(body))
                    self.server.owner.assertEqual(len(pdf.pages), 2)
                    self.server.owner.assertEqual(
                        pdf.metadata.title, "Page Between document sample"
                    )
                    counts["uploads"] += 1
                    self.send_response(200)
                    self.end_headers()

                def do_GET(self):
                    if self.path.startswith("/result"):
                        self.server.owner.assertIsNone(
                            self.headers.get("Authorization")
                        )
                        counts["downloads"] += 1
                        self.send_response(200)
                        self.end_headers()
                        self.wfile.write(result_zip)
                    else:
                        counts["queried"] += 1
                        item = (
                            {
                                "state": "running",
                                "extract_progress": {
                                    "extracted_pages": 1,
                                    "total_pages": 2,
                                },
                            }
                            if counts["queried"] == 1
                            else {
                                "state": "done",
                                "full_zip_url": f"http://127.0.0.1:{self.server.server_port}/result.zip?signature=temporary-fixture",
                            }
                        )
                        self.respond({"extract_result": [item]})

            http = ThreadingHTTPServer(("127.0.0.1", 0), Service)
            http.owner = self
            worker = threading.Thread(target=http.serve_forever, daemon=True)
            worker.start()
            try:
                with (
                    patch.object(book_import, "BOOK_ROOT", root / "books"),
                    patch.object(mineru, "BOOK_ROOT", root / "books"),
                    patch.object(
                        mineru.service_settings,
                        "effective",
                        return_value={
                            "baseUrl": f"http://127.0.0.1:{http.server_port}/api/v4",
                            "model": "vlm",
                            "key": "fixture-credential",
                        },
                    ),
                ):
                    book = book_import.import_book(source)
                    cancel = threading.Event()

                    def phase(message):
                        if message.startswith("云端解析"):
                            cancel.set()

                    with self.assertRaises(mineru.Paused):
                        mineru.run(book, [2, 4], phase, cancel)
                    self.assertEqual(counts["created"], 1)
                    cancel.clear()
                    patch_result = mineru.run(
                        book, [2, 4], lambda message: None, cancel
                    )
                    self.assertEqual(patch_result["enhancedPages"], [2, 4])
                    self.assertEqual(counts["created"], 1)
                    self.assertEqual(counts["uploads"], 1)
                    self.assertEqual(counts["downloads"], 1)
                    book.update(patch_result)
                    mineru.run(book, [2, 4], lambda message: None, cancel)
                    self.assertEqual(counts["created"], 1)
                    for path in (root / "books").rglob("job.json"):
                        self.assertNotIn("fixture-credential", path.read_text())
                        self.assertNotIn("temporary-fixture", path.read_text())
                    mineru.run(
                        book,
                        [2, 4],
                        lambda message: None,
                        cancel,
                        fresh="explicit-rerun",
                    )
                    self.assertEqual(counts["created"], 2)
                    mineru.run(
                        book,
                        [2, 4],
                        lambda message: None,
                        cancel,
                        fresh="explicit-rerun",
                    )
                    self.assertEqual(
                        counts["created"],
                        2,
                        "Restarting a fresh operation must not submit twice.",
                    )
                    original_hash = (
                        __import__("hashlib").sha256(source.read_bytes()).digest()
                    )
                    self.assertEqual(
                        original_hash,
                        __import__("hashlib")
                        .sha256(book_import.path_for(book["url"]).read_bytes())
                        .digest(),
                    )
                    shutil.rmtree(root / "books" / book["id"] / "mineru")
                    mineru.run(book, [2, 4], lambda message: None, cancel)
                    self.assertEqual(
                        counts["created"],
                        2,
                        "Clearing completed caches must reuse canonical results.",
                    )
            finally:
                http.shutdown()
                http.server_close()
                worker.join()


if __name__ == "__main__":
    unittest.main()
