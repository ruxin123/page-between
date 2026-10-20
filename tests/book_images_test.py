import base64
import io
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from PIL import Image, PngImagePlugin

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ai_tutor as tutor
import book_images
import book_import


def image_data(width=120, height=80):
    image = Image.new("RGB", (width, height), "#79a18d")
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("description", "synthetic metadata, stripped before sending")
    output = io.BytesIO()
    image.save(output, format="PNG", pnginfo=metadata)
    image.close()
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()


class BookImages(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.overrides = [
            patch.object(book_import, "BOOK_ROOT", self.root / "books"),
            patch.object(tutor, "DATA", self.root),
            patch.object(tutor.book_index, "CACHE", self.root / "cache"),
            patch.object(tutor.service_settings, "CONFIG", self.root / "services.json"),
            patch.object(tutor.service_settings, "ROOT", self.root),
            patch.object(tutor, "ACTIVE", set()),
            patch.object(tutor, "CANCELLATIONS", {}),
            patch.dict(
                tutor.service_settings.os.environ,
                {
                    "AI_BASE_URL": "http://127.0.0.1:1/v1",
                    "AI_MODEL": "synthetic-vision",
                    "AI_API_KEY": "",
                },
            ),
        ]
        for override in self.overrides:
            override.start()
        source = self.root / "sample.txt"
        source.write_text("第一章 开始\n\n一段原创图表问答测试资料。")
        self.book = book_import.import_book(source)
        self.source = {
            "quote": "",
            "context": "",
            "position": {"index": 1},
            "image": image_data(),
        }

    def tearDown(self):
        for override in reversed(self.overrides):
            override.stop()
        self.temp.cleanup()

    def test_owned_image_is_deduplicated_metadata_stripped_and_verified(self):
        url = book_images.save_image(self.book, self.source["image"])
        self.assertEqual(book_images.save_image(self.book, self.source["image"]), url)
        path = book_import.path_for(url)
        self.assertEqual(len(list(path.parent.glob("*.png"))), 1)
        body, mime = book_images.stored_image(self.book, url)
        self.assertEqual(mime, "image/png")
        with Image.open(io.BytesIO(body)) as image:
            self.assertEqual(image.size, (120, 80))
            self.assertNotIn("description", image.info)
        self.assertEqual(book_images.save_image(self.book, url), url)
        self.assertTrue(
            book_images.image_part(self.book, url)["image_url"]["url"].startswith(
                "data:image/png;base64,"
            )
        )
        with self.assertRaises(ValueError):
            book_images.stored_image({**self.book, "id": "different-book"}, url)
        path.write_bytes(path.read_bytes() + b"tampered")
        with self.assertRaisesRegex(ValueError, "校验失败"):
            book_images.image_part(self.book, url)

    def test_invalid_remote_oversized_and_vector_payloads_are_rejected(self):
        for value in (
            "https://example.invalid/image.png",
            "file:///private/image.png",
            "data:image/svg+xml;base64,"
            + base64.b64encode(b'<svg xmlns="http://www.w3.org/2000/svg"/>').decode(),
            "data:image/png;base64,broken!",
            image_data(4097, 1),
            "data:image/png;base64," + "A" * (6 * 1024**2),
            False,
        ):
            with self.assertRaises(ValueError):
                book_images.save_image(self.book, value)
        self.assertFalse(
            (self.root / "books" / self.book["id"] / "attachments").exists()
        )

    def test_real_http_multimodal_request_and_opt_out_followup(self):
        received = []

        class Provider(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                received.append(
                    json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                )
                body = json.dumps(
                    {
                        "choices": [
                            {"message": {"content": "这是可控服务的图表答复。[1]"}}
                        ]
                    }
                ).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        http = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        worker = threading.Thread(target=http.serve_forever, daemon=True)
        worker.start()
        try:
            config = {
                "baseUrl": f"http://127.0.0.1:{http.server_port}/v1",
                "model": "synthetic-vision",
                "key": "",
                "supportsImages": True,
            }
            tutor.service_settings.update("ai", config)
            result = tutor.ask(
                self.book,
                {"question": "解释这张图", "source": self.source, "sendImage": True},
            )
            self.assertEqual(result["messages"][-1]["status"], "ready")
            self.assertTrue(result["messages"][0]["imageAttached"])
            content = received[0]["messages"][1]["content"]
            self.assertEqual([part["type"] for part in content], ["text", "image_url"])
            self.assertIn("[1]", content[0]["text"])
            body = base64.b64decode(content[1]["image_url"]["url"].split(",", 1)[1])
            with Image.open(io.BytesIO(body)) as image:
                self.assertEqual(image.size, (120, 80))
            self.assertIn("/attachments/", result["source"]["image"])
            self.assertNotIn(
                "base64", (self.root / "ai-conversations.json").read_text()
            )
            followup = tutor.ask(
                self.book,
                {
                    "conversation": result["id"],
                    "question": "只依据刚才的文字继续解释",
                    "sendImage": False,
                },
            )
            self.assertIsInstance(received[-1]["messages"][1]["content"], str)
            self.assertNotIn("image_url", json.dumps(received[-1]))
            self.assertNotIn("attachments/", json.dumps(received[-1]))
            self.assertFalse(followup["messages"][-1]["imageAttached"])
            self.assertEqual(followup["source"]["image"], result["source"]["image"])
            self.assertEqual(
                len(tutor.conversation(result["id"], self.book["id"])["messages"]), 4
            )
        finally:
            http.shutdown()
            http.server_close()
            worker.join()

    def test_vision_requires_capability_and_retry_keeps_original_attachment(self):
        request = {"question": "解释原图", "source": self.source, "sendImage": True}
        with self.assertRaisesRegex(tutor.TutorError, "文字模式"):
            tutor.ask(self.book, request)
        self.assertFalse((self.root / "ai-conversations.json").exists())
        tutor.service_settings.update(
            "ai",
            {
                "baseUrl": "http://127.0.0.1:1/v1",
                "model": "synthetic-vision",
                "supportsImages": True,
            },
        )
        with patch.object(
            tutor, "complete", side_effect=tutor.TutorError("synthetic interruption")
        ):
            with self.assertRaises(tutor.TutorError) as failure:
                tutor.ask(self.book, request)
        ident = failure.exception.conversation
        with patch.object(tutor, "complete", return_value="重试答复。[1]") as complete:
            result = tutor.ask(
                self.book, {"conversation": ident, "question": "retry", "retry": True}
            )
            self.assertEqual(
                complete.call_args[0][1][1]["content"][1]["type"], "image_url"
            )
        self.assertEqual(len(result["messages"]), 2)
        self.assertTrue(result["messages"][-1]["imageAttached"])
        self.assertFalse(tutor.ACTIVE)


if __name__ == "__main__":
    unittest.main()
