"""Exercise the frozen service with isolated data and only the bundled tools on PATH."""

import argparse
import io
import json
import os
import queue
import subprocess
import tempfile
import threading
import urllib.error
import urllib.request
import zipfile
from pathlib import Path


def verify(app):
    app = app.resolve()
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
            path, data=None, authenticated=True, content_type="application/octet-stream"
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
                if authenticated:
                    raise RuntimeError(
                        path + ": " + error.read().decode()[:1500]
                    ) from None
                raise

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
            ocr = json.loads(request("/api/ocr?book=demo-e&page=1")[2])
            assert ocr["lines"] and ocr["engine"] == "tesseract-eng"
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
            assert len(json.loads(request("/api/library")[2])["books"]) == 7
            information = json.loads(request("/api/data/info")[2])
            assert (
                information["lastRestore"]["restored"]
                and information["previousAvailable"]
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
                "protectedSession": True,
                "restartPersistence": True,
                "bookSearch": True,
                "epubExport": True,
                "originalPageMapping": True,
                "verifiedBackupRestore": True,
                "signature": "ad-hoc verified",
            }
        finally:
            if process and process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
            log.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    print(json.dumps(verify(parser.parse_args().app), ensure_ascii=False))
