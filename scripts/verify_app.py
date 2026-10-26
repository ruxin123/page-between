"""Exercise the frozen service with isolated data and only the bundled tools on PATH."""

import argparse
import base64
import io
import json
import os
import queue
import shutil
import subprocess
import struct
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from xml.etree import ElementTree as ET


def verify(app, epubcheck=None, samples=()):
    app = app.resolve()
    if epubcheck is not None:
        epubcheck = epubcheck.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="page-between-app-check-") as temporary:
        root = Path(temporary).resolve()
        session = "SyntheticVerificationSession2026"
        env = {
            **os.environ,
            "PAGE_BETWEEN_APP": "1",
            "PAGE_BETWEEN_SESSION": session,
            "PAGE_BETWEEN_DATA_DIR": str(root / "Library"),
            "PAGE_BETWEEN_CONFIG_DIR": str(root / "settings"),
            "PAGE_BETWEEN_CACHE_DIR": str(root / "cache"),
            "PAGE_BETWEEN_NATIVE_DIR": str(app / "Contents/Helpers/native"),
            "PATH": str(app / "Contents/Frameworks/bin") + ":/usr/bin:/bin",
            "TESSDATA_PREFIX": str(app / "Contents/Resources/tessdata"),
        }
        for name in (
            "AI_BASE_URL",
            "AI_MODEL",
            "AI_API_KEY",
            "MINERU_API_TOKEN",
            "PAGE_BETWEEN_PARENT_PID",
        ):
            env.pop(name, None)
        process = None
        provider = None
        log = (root / "service.log").open("w")

        def start():
            nonlocal process
            process = subprocess.Popen(
                [
                    str(app / "Contents/MacOS/page-between-engine"),
                    "--demo",
                    "--port",
                    "0",
                ],
                env=env,
                stdout=subprocess.PIPE,
                stderr=log,
                text=True,
            )
            lines = queue.Queue()
            threading.Thread(
                target=lambda: lines.put(process.stdout.readline()), daemon=True
            ).start()
            line = lines.get(timeout=45)
            if not line:
                raise RuntimeError(
                    "Frozen service exited during startup; inspect its build dependencies."
                )
            value = json.loads(line)
            assert value["ready"]
            return "http://127.0.0.1:" + str(value["port"])

        def request(
            path,
            data=None,
            authenticated=True,
            content_type="application/octet-stream",
            expected_status=200,
        ):
            headers = {"X-Page-Between-Session": session} if authenticated else {}
            if data is not None:
                headers["Content-Type"] = content_type
            try:
                with urllib.request.urlopen(
                    urllib.request.Request(base + path, data=data, headers=headers),
                    timeout=120,
                ) as response:
                    return response.status, response.headers, response.read()
            except urllib.error.HTTPError as error:
                if error.code == expected_status:
                    return error.code, error.headers, error.read()
                if authenticated:
                    raise RuntimeError(
                        path + ": " + error.read().decode()[:1500]
                    ) from None
                raise

        def check_epub(body, name):
            with zipfile.ZipFile(io.BytesIO(body)) as archive:
                first = archive.infolist()[0]
                assert (
                    first.filename == "mimetype"
                    and first.compress_type == zipfile.ZIP_STORED
                )
                assert (
                    not first.extra and archive.read(first) == b"application/epub+zip"
                )
                container = ET.fromstring(archive.read("META-INF/container.xml"))
                assert container.get("version") == "1.0"
                package = container.find("{*}rootfiles/{*}rootfile")
                assert package.get("media-type") == "application/oebps-package+xml"
                metadata = ET.fromstring(archive.read(package.get("full-path")))
                image_resources = sum(
                    item.get("media-type", "").startswith("image/")
                    for item in metadata.findall("{*}manifest/{*}item")
                )
                assert not metadata.get("version", "").startswith("3.") or (
                    len(
                        metadata.findall(
                            "{*}metadata/{*}meta[@property='dcterms:modified']"
                        )
                    )
                    == 1
                )
            if epubcheck is not None:
                path = root / (name + ".epub")
                path.write_bytes(body)
                checked = subprocess.run(
                    ["java", "-jar", str(epubcheck), str(path), "--failonwarnings"],
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                assert checked.returncode == 0, checked.stdout + checked.stderr
            return image_resources

        def export_epub(ident):
            prepared = json.loads(
                request(
                    "/api/export/epub",
                    json.dumps({"book": ident}).encode(),
                    content_type="application/json",
                )[2]
            )
            return prepared, request(prepared["download"])[2]

        try:
            base = start()
            assert request("/api/health", authenticated=False)[0] == 200
            try:
                request("/api/library", authenticated=False)
            except urllib.error.HTTPError as error:
                assert error.code == 401
            else:
                raise AssertionError(
                    "The desktop library allowed an unauthenticated read."
                )
            library = json.loads(request("/api/library")[2])
            assert len(library["books"]) == 5
            for path in (
                "/",
                "/app-v2.mjs",
                "/ui/settings.mjs",
                "/ui/navigation.mjs",
                "/ui/ocr-layer.mjs",
                "/assets/fonts/han-serif.otf",
                "/assets/vendor/pdf.mjs",
                "/demo-data/books/demo-a/content/OPS/chapter-2.xhtml",
            ):
                assert request(path)[0] == 200
            text = "第一章 开始\n正文包含中文、English 和 😀。\n第二章 继续\n第二段正文。".encode()
            book = json.loads(request("/api/import?name=sample.txt&parse=1", text)[2])[
                "book"
            ]
            assert len(book["chapters"]) == 2
            assert "😀" in json.loads(request(book["contentUrl"])[2])[0]["body"]
            for _ in range(100):
                book = next(
                    item
                    for item in json.loads(request("/api/library")[2])["books"]
                    if item["id"] == book["id"]
                )
                if book["processing"] != "pending":
                    break
                time.sleep(0.1)
            revision = book.get("structureRevision", "")
            chapters_path = "/api/books/" + book["id"] + "/chapters"
            book = json.loads(
                request(
                    chapters_path,
                    json.dumps(
                        {
                            "action": "rename",
                            "index": 1,
                            "title": "原生章节调整验证",
                            "revision": revision,
                        }
                    ).encode(),
                    content_type="application/json",
                )[2]
            )["book"]
            assert book["chapters"][0]["title"] == "原生章节调整验证"
            assert (
                request(
                    chapters_path,
                    json.dumps(
                        {
                            "action": "rename",
                            "index": 1,
                            "title": "旧窗口不应覆盖",
                            "revision": revision,
                        }
                    ).encode(),
                    content_type="application/json",
                    expected_status=409,
                )[0]
                == 409
            )

            # Source formatting uses bundled Pandoc before any model is configured.
            objects = json.loads(request("/api/enrichment?book=demo-e&page=1")[2])[
                "blocks"
            ]
            for kind in ("equation", "table"):
                original = next(
                    block["text"] for block in objects if block["type"] == kind
                )
                preview = json.loads(
                    request(
                        "/api/ai/preview",
                        json.dumps(
                            {
                                "book": "demo-e",
                                "quote": original,
                                "position": {"index": 1},
                            }
                        ).encode(),
                        content_type="application/json",
                    )[2]
                )["html"]
                assert ("<math" if kind == "equation" else "<table") in preview
            assert (
                request(
                    "/api/ai/preview",
                    json.dumps(
                        {
                            "book": "demo-e",
                            "quote": "x" * 6001,
                            "position": {"index": 1},
                        }
                    ).encode(),
                    content_type="application/json",
                    expected_status=400,
                )[0]
                == 400
            )

            received = []

            class ImageProvider(BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass

                def do_POST(self):
                    received.append(
                        json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    )
                    body = '{"choices":[{"message":{"content":"Image transport verified. [1]"}}]}'.encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

            provider = ThreadingHTTPServer(("127.0.0.1", 0), ImageProvider)
            provider_thread = threading.Thread(
                target=provider.serve_forever, daemon=True
            )
            provider_thread.start()
            request(
                "/api/settings/save",
                json.dumps(
                    {
                        "service": "ai",
                        "config": {
                            "baseUrl": f"http://127.0.0.1:{provider.server_port}/v1",
                            "model": "synthetic-vision",
                            "supportsImages": True,
                            "key": "",
                        },
                    }
                ).encode(),
                content_type="application/json",
            )

            # A valid noisy PNG exercises a real image request larger than the JSON default limit.
            def chunk(kind, body):
                return (
                    struct.pack(">I", len(body))
                    + kind
                    + body
                    + struct.pack(">I", zlib.crc32(kind + body))
                )

            pixels = b"".join(b"\x00" + os.urandom(1000 * 3) for _ in range(800))
            png = (
                b"\x89PNG\r\n\x1a\n"
                + chunk(b"IHDR", struct.pack(">IIBBBBB", 1000, 800, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(pixels))
                + chunk(b"IEND", b"")
            )
            image_payload = json.dumps(
                {
                    "book": book["id"],
                    "question": "验证图像请求",
                    "sendImage": True,
                    "previousKnowledge": False,
                    "source": {
                        "quote": "",
                        "context": "",
                        "position": {"index": 1},
                        "image": "data:image/png;base64,"
                        + base64.b64encode(png).decode(),
                    },
                }
            ).encode()
            assert len(image_payload) > 2 * 1024**2
            conversation = json.loads(
                request("/api/ai/ask", image_payload, content_type="application/json")[
                    2
                ]
            )["conversation"]
            assert (
                conversation["messages"][-1]["status"] == "ready"
                and conversation["messages"][0]["imageAttached"]
            )
            assert received[0]["messages"][1]["content"][1]["type"] == "image_url"
            image_url = conversation["source"]["image"]
            image_bytes = request(image_url)[2]
            check_epub(export_epub(book["id"])[1], "text")
            for ident in ("demo-a", "demo-d"):
                result, body = export_epub(ident)
                assert not result["compatibilityUpdated"]
                check_epub(body, ident)
            # Reproduce an existing 0.4.0 demo library, not just fresh fixtures.
            legacy = io.BytesIO()
            with (
                zipfile.ZipFile(io.BytesIO(export_epub("demo-a")[1])) as source,
                zipfile.ZipFile(legacy, "w", zipfile.ZIP_DEFLATED) as target,
            ):
                for item in source.infolist():
                    body = source.read(item)
                    if item.filename == "META-INF/container.xml":
                        body = body.replace(b' version="1.0"', b"").replace(
                            b' media-type="application/oebps-package+xml"', b""
                        )
                    if item.filename == "OPS/book.opf":
                        body = body.replace(
                            b'<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>',
                            b"",
                        ).replace(b' properties="mathml"', b"")
                    target.writestr(item.filename, body)
            legacy_book = json.loads(
                request("/api/import?name=legacy.epub&parse=0", legacy.getvalue())[2]
            )["book"]
            repaired, body = export_epub(legacy_book["id"])
            assert repaired["compatibilityUpdated"]
            check_epub(body, "legacy-repaired")
            assert request(legacy_book["originalUrl"])[2] == legacy.getvalue()
            ocr = json.loads(request("/api/ocr?book=demo-e&page=1")[2])
            assert ocr["lines"] and ocr["engine"] == "tesseract-eng"
            request(
                "/api/pdf/prepare",
                json.dumps({"book": "demo-e", "action": "all"}).encode(),
                content_type="application/json",
            )
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                local = json.loads(request("/api/pdf/preparation?book=demo-e")[2])[
                    "local"
                ]
                task = root / "Library/books/demo-e/selection-preparation.json"
                if (
                    local["completed"] == 4
                    and task.is_file()
                    and json.loads(task.read_text()).get("status") == "ready"
                ):
                    break
                time.sleep(0.1)
            else:
                raise AssertionError(
                    "Frozen whole-book selection preparation did not finish"
                )
            prepared_files = {
                path.relative_to(root / "Library").as_posix(): __import__("hashlib")
                .sha256(path.read_bytes())
                .hexdigest()
                for path in (root / "Library/books/demo-e/selection-text-v1").rglob(
                    "*.json"
                )
            }
            assert (
                len([name for name in prepared_files if Path(name).stem.isdigit()]) == 4
            )
            scan_original = next(
                item for item in library["books"] if item["id"] == "demo-e"
            )
            scan_bytes = request(scan_original["originalUrl"])[2]
            selection_book = json.loads(
                request(
                    "/api/import?name=prepared-search.pdf&parse=1",
                    scan_bytes + b"\n% Independent saved-selection search fixture\n",
                )[2]
            )["book"]
            assert not selection_book.get("enrichmentUrl")
            selection_query = next(
                word
                for line in ocr["lines"]
                for word in line["text"].split()
                if len(word) >= 6 and word.isascii() and word.isalpha()
            )
            request(
                "/api/pdf/prepare",
                json.dumps({"book": selection_book["id"], "action": "all"}).encode(),
                content_type="application/json",
            )
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                local = json.loads(
                    request("/api/pdf/preparation?book=" + selection_book["id"])[2]
                )["local"]
                if local["completed"] == 4:
                    break
                time.sleep(0.1)
            else:
                raise AssertionError("Independent scan preparation did not finish")

            def search_prepared_scan():
                result = json.loads(
                    request(
                        "/api/index/search",
                        json.dumps(
                            {
                                "book": selection_book["id"],
                                "query": selection_query,
                                "position": {"index": 2},
                                "previousOnly": True,
                            }
                        ).encode(),
                        content_type="application/json",
                    )[2]
                )
                assert result["status"]["covered"] == 4
                assert result["results"] and all(
                    item["position"]["index"] == 1 for item in result["results"]
                )

            search_prepared_scan()
            prepared_files.update(
                {
                    path.relative_to(root / "Library").as_posix(): __import__("hashlib")
                    .sha256(path.read_bytes())
                    .hexdigest()
                    for path in (
                        root
                        / "Library/books"
                        / selection_book["id"]
                        / "selection-text-v1"
                    ).rglob("*.json")
                }
            )
            search = json.loads(
                request(
                    "/api/index/search",
                    json.dumps(
                        {
                            "book": "demo-c",
                            "query": "Definition 1.1",
                            "position": {"index": 2, "anchor": None},
                            "previousOnly": True,
                        }
                    ).encode(),
                    content_type="application/json",
                )[2]
            )
            assert search["results"] and all(
                source["position"]["index"] == 1 for source in search["results"]
            )
            export = json.loads(
                request(
                    "/api/export/epub",
                    json.dumps({"book": "demo-e", "pages": "1-2"}).encode(),
                    content_type="application/json",
                )[2]
            )
            epub = request(export["download"])[2]
            check_epub(epub, "pdf-reflow")
            with zipfile.ZipFile(io.BytesIO(epub)) as archive:
                text = "".join(
                    archive.read(name).decode()
                    for name in archive.namelist()
                    if name.endswith(".xhtml")
                )
                assert "<math" in text and "<table" in text and "<img" in text
            reflow = json.loads(
                request("/api/import?name=reflow.epub&parse=0", epub)[2]
            )["book"]
            assert reflow["sourcePdfHash"] and reflow["sourcePdfPages"] == [1, 2]
            request(
                "/api/state",
                json.dumps({"prefs": {"fontSize": 23}}).encode(),
                content_type="application/json",
            )
            backup = json.loads(
                request("/api/data/backup", b"{}", content_type="application/json")[2]
            )
            archive = request(backup["download"])[2]
            request(
                "/api/state",
                json.dumps({"prefs": {"fontSize": 31}}).encode(),
                content_type="application/json",
            )
            request("/api/data/restore", archive)
            request("/api/data/approve-restore", b"{}", content_type="application/json")
            process.terminate()
            process.wait(timeout=10)
            base = start()
            assert json.loads(request("/api/state")[2])["prefs"]["fontSize"] == 23
            for name, checksum in prepared_files.items():
                assert (
                    __import__("hashlib")
                    .sha256((root / "Library" / name).read_bytes())
                    .hexdigest()
                    == checksum
                )
            saved_page = next(
                (root / "Library/books/demo-e/selection-text-v1").glob("*/2.json")
            )
            before_prepared = saved_page.stat().st_mtime_ns
            assert json.loads(request("/api/ocr?book=demo-e&page=2")[2])["lines"]
            assert saved_page.stat().st_mtime_ns == before_prepared, (
                "Restored prepared text was recognized again"
            )
            assert (
                json.loads(request("/api/pdf/preparation?book=demo-e")[2])["local"][
                    "completed"
                ]
                == 4
            )
            assert len(json.loads(request("/api/library")[2])["books"]) == 9
            shutil.rmtree(root / "cache/book-index-v2", ignore_errors=True)
            search_prepared_scan()
            restored = json.loads(
                request(
                    "/api/ai/conversations?book="
                    + book["id"]
                    + "&id="
                    + conversation["id"]
                )[2]
            )["conversation"]
            assert (
                restored["source"]["image"] == image_url
                and request(image_url)[2] == image_bytes
            )
            information = json.loads(request("/api/data/info")[2])
            assert (
                information["lastRestore"]["restored"]
                and information["previousAvailable"]
            )
            process.terminate()
            process.wait(timeout=10)
            collection = json.loads((root / "Library/library.json").read_text())
            before_state = (root / "Library/state.json").read_bytes()
            for sample in collection["books"]:
                if sample["id"] in {"demo-c", "demo-e"}:
                    for field in ("enrichmentUrl", "enhancedPages", "demoEnhancement"):
                        sample.pop(field, None)
            (root / "Library/library.json").write_text(
                json.dumps(collection, ensure_ascii=False)
            )
            base = start()
            assert (root / "Library/state.json").read_bytes() == before_state
            for ident in ("demo-c", "demo-e"):
                blocks = json.loads(
                    request("/api/enrichment?book=" + ident + "&page=1")[2]
                )["blocks"]
                assert {"equation", "table", "image"} <= {
                    block["type"] for block in blocks
                }
            sample_results = []
            for sample in samples:
                image_resources = None
                original = sample.read_bytes()
                imported = json.loads(
                    request(
                        "/api/import?name=sample" + sample.suffix.lower() + "&parse=0",
                        original,
                    )[2]
                )["book"]
                assert request(imported["originalUrl"])[2] == original
                if imported["type"] == "pdf":
                    assert imported["pages"] > 0
                else:
                    assert imported["chapters"] and imported["toc"]
                    if imported["type"] == "epub":
                        for chapter in imported["chapters"]:
                            assert request(chapter["url"])[2]
                    image_resources = check_epub(
                        export_epub(imported["id"])[1],
                        "sample-" + sample.suffix.lower().lstrip("."),
                    )
                sample_results.append(
                    {
                        "format": imported["format"],
                        "chapters": len(imported.get("chapters", [])),
                        "toc": len(imported.get("toc", [])),
                        "imageResources": image_resources,
                    }
                )
            subprocess.run(
                ["codesign", "--verify", "--deep", "--strict", str(app)], check=True
            )
            return {
                "standaloneService": True,
                "developmentPath": False,
                "demoBooks": 5,
                "import": True,
                "bundledOCR": True,
                "wholeBookLocalPreparation": True,
                "savedSelectionBackupAndRestart": True,
                "savedSelectionSearchAfterRestore": True,
                "protectedSession": True,
                "restartPersistence": True,
                "bookSearch": True,
                "epubExport": True,
                "manualChapters": True,
                "imageRequestOver2MB": True,
                "imageBackupRestore": True,
                "ownedDemoUpgrade": True,
                "legacyEpubRepair": True,
                "epubPackaging": True,
                "epubcheck": epubcheck is not None,
                "originalPageMapping": True,
                "verifiedBackupRestore": True,
                "signature": "ad-hoc verified",
                "formatSamples": sample_results,
            }
        finally:
            if process and process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
            log.close()
            if provider is not None:
                provider.shutdown()
                provider.server_close()
                provider_thread.join()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument(
        "--epubcheck",
        type=Path,
        help="EPUBCheck JAR; reject errors and warnings in actual frozen exports",
    )
    parser.add_argument(
        "--sample",
        type=Path,
        action="append",
        default=[],
        help="Additional local, readable book sample; original bytes and EPUB export are checked without publishing its title or content",
    )
    args = parser.parse_args()
    print(json.dumps(verify(args.app, args.epubcheck, args.sample), ensure_ascii=False))
