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
from contextlib import contextmanager
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, NumberObject

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
                            {"state": "waiting-file"}
                            if counts["queried"] <= 2
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
                        if message.startswith(("云端解析", "等待云端确认上传")):
                            cancel.set()

                    with self.assertRaises(mineru.Paused):
                        mineru.run(book, [2, 4], phase, cancel)
                    self.assertEqual(counts["created"], 1)
                    for path in (root / "books").rglob("job.json"):
                        self.assertTrue(
                            json.loads(path.read_text())["chunks"]["0"]["uploaded"]
                        )
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

    def test_unconfirmed_upload_and_malformed_results_keep_the_existing_cloud_task(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / "sample.pdf"
            make_pdf(source)
            with (
                patch.object(book_import, "BOOK_ROOT", root / "books"),
                patch.object(mineru, "BOOK_ROOT", root / "books"),
                patch.object(
                    mineru.service_settings,
                    "effective",
                    return_value={
                        "baseUrl": "https://mineru.net/api/v4",
                        "model": "vlm",
                        "key": "fixture-credential",
                    },
                ),
            ):
                book = book_import.import_book(source)
                cancel = threading.Event()
                with (
                    patch.object(
                        mineru,
                        "api",
                        return_value={
                            "batch_id": "existing-batch",
                            "file_urls": ["https://mineru.net/upload"],
                        },
                    ),
                    patch.object(
                        mineru,
                        "upload",
                        side_effect=mineru.MinerUError("Upload interrupted"),
                    ),
                ):
                    with self.assertRaisesRegex(
                        mineru.MinerUError, "Upload interrupted"
                    ):
                        mineru.run(book, [2, 4], lambda message: None, cancel)
                for response, message in (
                    ({"extract_result": [{"state": "waiting-file"}]}, "已保留任务"),
                    ({"extract_result": []}, "已保留原任务"),
                    ({"extract_result": None}, "已保留原任务"),
                ):
                    with (
                        self.subTest(response=response),
                        patch.object(mineru, "api", return_value=response) as api,
                        patch.object(mineru, "upload") as upload,
                        patch.object(mineru.time, "monotonic", side_effect=[0, 61]),
                    ):
                        with self.assertRaisesRegex(mineru.MinerUError, message):
                            mineru.run(book, [2, 4], lambda message: None, cancel)
                        self.assertEqual(api.call_count, 1)
                        self.assertEqual(
                            api.call_args.args[1],
                            "/extract-results/batch/existing-batch",
                        )
                        upload.assert_not_called()


class WholeBookBatches(unittest.TestCase):
    def test_old_missing_page_plan_is_adopted_without_resubmitting_completed_batches(
        self,
    ):
        book = self.book(4)
        target = self.root / "books" / book["id"] / "mineru-enhancement.json"
        original = {
            "1": {"engine": "mineru", "blocks": [{"text": "Already accepted 1"}]}
        }
        save = __import__("storage").save
        save(target, original)
        book["enrichmentUrl"] = book_import.url_for(target)
        cancel = threading.Event()

        def phase(message):
            if message.startswith("准备页段 3-"):
                cancel.set()

        with (
            patch.object(mineru, "MAX_BATCH_PAGES", 2),
            self.cloud() as (uploaded, created),
        ):
            with self.assertRaises(mineru.Paused):
                mineru.run(book, [2, 3, 4], phase, cancel)
            save(target, original)
            old_manifest = next(target.parent.glob("mineru/*/job.json"))
            legacy = json.loads(old_manifest.read_text())
            legacy.pop("planPages")
            save(old_manifest, legacy)
            cancel.clear()
            complete = mineru.run(book, [1, 2, 3, 4], lambda message: None, cancel)
            self.assertEqual(uploaded, [[2, 3], [4]])
            self.assertEqual(len(created), 2)
            self.assertEqual(complete["mineruPages"], [1, 2, 3, 4])
            current = next(target.parent.glob("mineru/*/job.json"))
            state = json.loads(current.read_text())
            self.assertEqual(state["pages"], [1, 2, 3, 4])
            self.assertEqual(state["planPages"], [2, 3, 4])

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.patches = [
            patch.object(book_import, "BOOK_ROOT", self.root / "books"),
            patch.object(mineru, "BOOK_ROOT", self.root / "books"),
            patch.object(
                mineru.service_settings,
                "effective",
                return_value={
                    "baseUrl": "https://mineru.net/api/v4",
                    "model": "vlm",
                    "key": "fixture-credential",
                },
            ),
        ]
        for override in self.patches:
            override.start()

    def tearDown(self):
        for override in reversed(self.patches):
            override.stop()
        self.temporary.cleanup()

    def book(self, count):
        source = self.root / "original.pdf"
        writer = PdfWriter()
        for number in range(1, count + 1):
            page = writer.add_blank_page(width=200, height=300)
            page[NameObject("/OriginalNumber")] = NumberObject(number)
        writer.write(source)
        writer.close()
        return book_import.import_book(source, enabled=True)

    @staticmethod
    def page(index, number):
        return {
            "page_idx": index,
            "page_size": [200, 300],
            "para_blocks": [
                {
                    "type": "text",
                    "bbox": [10, 10, 190, 50],
                    "lines": [{"spans": [{"content": f"Original page {number}"}]}],
                }
            ],
        }

    @contextmanager
    def cloud(self, corrupt=None):
        uploaded, batches = [], {}
        created = []

        def api(config, path, body=None):
            if body is not None:
                ident = str(len(created) + 1)
                created.append(ident)
                return {
                    "batch_id": ident,
                    "file_urls": ["https://mineru.net/upload/" + ident],
                }
            ident = path.rsplit("/", 1)[-1]
            self.assertIn(ident, batches)
            return {
                "extract_result": [
                    {
                        "state": "done",
                        "full_zip_url": "https://mineru.net/result/" + ident,
                    }
                ]
            }

        def upload(config, url, source):
            self.assertLessEqual(source.stat().st_size, mineru.MAX_UPLOAD_BYTES)
            numbers = [int(page["/OriginalNumber"]) for page in PdfReader(source).pages]
            self.assertLessEqual(len(numbers), mineru.MAX_BATCH_PAGES)
            batches[url.rsplit("/", 1)[-1]] = numbers
            uploaded.append(numbers)

        def download(config, url, target):
            ident = url.rsplit("/", 1)[-1]
            numbers = batches[ident]
            if ident == corrupt:
                numbers = numbers[:-1]
            with zipfile.ZipFile(target, "w") as archive:
                archive.writestr(
                    "layout.json",
                    json.dumps(
                        {
                            "pdf_info": [
                                self.page(index, number)
                                for index, number in enumerate(numbers)
                            ]
                        }
                    ),
                )

        with (
            patch.object(mineru, "api", side_effect=api),
            patch.object(mineru, "upload", side_effect=upload),
            patch.object(mineru, "download", side_effect=download),
        ):
            yield uploaded, created

    def test_batches_publish_immediately_and_resume_a_frozen_plan_after_coverage_changes(
        self,
    ):
        book = self.book(305)
        existing = [1, 150, 305]
        target = self.root / "books" / book["id"] / "mineru-enhancement.json"
        save = __import__("storage").save
        save(
            target,
            {
                str(page): {
                    "engine": "mineru",
                    "blocks": [{"text": f"Already accepted {page}"}],
                }
                for page in existing
            },
        )
        book["enrichmentUrl"] = book_import.url_for(target)
        cancel = threading.Event()
        published = []

        def phase(message):
            if message.startswith("准备页段 151-"):
                cancel.set()

        with self.cloud() as (uploaded, created):
            with self.assertRaises(mineru.Paused):
                mineru.run(
                    book,
                    list(range(1, 306)),
                    phase,
                    cancel,
                    publish=lambda value: published.append(len(value["mineruPages"])),
                )
            self.assertEqual(len(json.loads(target.read_text())), 153)
            self.assertEqual(published, [153])
            cancel.clear()
            result = mineru.run(book, list(range(1, 306)), lambda message: None, cancel)
            self.assertEqual([len(group) for group in uploaded], [150, 150, 2])
            self.assertEqual(len(created), 3)
            self.assertEqual(
                [page for group in uploaded for page in group],
                [page for page in range(1, 306) if page not in existing],
            )
            self.assertEqual(result["mineruPages"], list(range(1, 306)))
            combined = json.loads(target.read_text())
            for page in range(1, 306):
                self.assertEqual(
                    combined[str(page)]["blocks"][0]["text"],
                    f"Already accepted {page}"
                    if page in existing
                    else f"Original page {page}",
                )

    def test_incomplete_batch_keeps_published_pages_and_does_not_resubmit_on_startup(
        self,
    ):
        book = self.book(4)
        cancel = threading.Event()
        with (
            patch.object(mineru, "MAX_BATCH_PAGES", 2),
            self.cloud(corrupt="2") as (uploaded, created),
        ):
            with self.assertRaisesRegex(mineru.MinerUError, "缺少页面"):
                mineru.run(book, [1, 2, 3, 4], lambda message: None, cancel)
            self.assertEqual(mineru.progress(book)["parsedPages"], [1, 2])
            with self.assertRaisesRegex(mineru.MinerUError, "此前批次"):
                mineru.run(book, [1, 2, 3, 4], lambda message: None, cancel)
            self.assertEqual(len(created), 2)
            result = mineru.run(
                book, [1, 2, 3, 4], lambda message: None, cancel, retry=True
            )
            self.assertEqual(result["mineruPages"], [1, 2, 3, 4])
            self.assertEqual(uploaded, [[1, 2], [3, 4], [3, 4]])
        with self.assertRaisesRegex(mineru.MinerUError, "重复页号"):
            mineru.normalized_pages(
                {"pdf_info": [self.page(0, 1), self.page(0, 2)]}, [1, 2]
            )

    def test_byte_limit_adapts_batches_and_single_oversized_page_never_submits(self):
        book = self.book(12)
        reader = PdfReader(book_import.path_for(book["url"]))
        writer = PdfWriter()
        for page in reader.pages[:2]:
            writer.add_page(page)
        writer.add_metadata({"/Title": "Page Between document sample"})
        stream = io.BytesIO()
        writer.write(stream)
        writer.close()
        with (
            patch.object(mineru, "MAX_UPLOAD_BYTES", len(stream.getvalue()) + 1),
            self.cloud() as (uploaded, created),
        ):
            result = mineru.run(
                book, list(range(1, 13)), lambda message: None, threading.Event()
            )
            self.assertEqual(result["mineruPages"], list(range(1, 13)))
            self.assertTrue(all(len(group) <= 2 for group in uploaded))
        with (
            patch.object(mineru, "MAX_UPLOAD_BYTES", 1),
            patch.object(mineru, "api") as api,
        ):
            with self.assertRaisesRegex(mineru.MinerUError, "无法自动拆分单页"):
                mineru.run(
                    book,
                    [1],
                    lambda message: None,
                    threading.Event(),
                    fresh="new-operation",
                )
            api.assert_not_called()


if __name__ == "__main__":
    unittest.main()
