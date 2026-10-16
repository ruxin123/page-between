import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ai_tutor as tutor
from lxml import html


class Tutor(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patches = [
            patch.object(tutor, "DATA", self.root),
            patch.object(tutor, "ROOT", self.root),
            patch.object(tutor, "ACTIVE", set()),
            patch.dict(
                tutor.os.environ,
                {
                    "AI_BASE_URL": "http://127.0.0.1:1/v1",
                    "AI_MODEL": "test-model",
                    "AI_API_KEY": "",
                },
            ),
        ]
        for override in self.patches:
            override.start()
        self.book = {
            "id": "demo",
            "title": "自编示例",
            "type": "epub",
            "chapters": [{"title": "第一章"}],
        }
        self.payload = {
            "question": "这是什么意思？",
            "source": {
                "quote": "每个输入恰好对应一个输出。",
                "context": "本章介绍函数的定义。",
                "position": {"index": 1, "page": 0},
            },
        }

    def tearDown(self):
        for override in reversed(self.patches):
            override.stop()
        self.temp.cleanup()

    def test_real_http_transport_and_persisted_followup(self):
        requests = []

        class Provider(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                requests.append(
                    json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                )
                data = json.dumps(
                    {
                        "choices": [
                            {"message": {"content": "**解释**：这是函数的定义。[1]"}}
                        ]
                    },
                    ensure_ascii=False,
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        http = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        worker = threading.Thread(target=http.serve_forever, daemon=True)
        worker.start()
        try:
            with patch.dict(
                tutor.os.environ,
                {"AI_BASE_URL": f"http://127.0.0.1:{http.server_port}/v1"},
            ):
                first = tutor.ask(self.book, self.payload)
                self.assertEqual(first["messages"][-1]["status"], "ready")
                self.assertIn("函数", first["messages"][-1]["html"])
                self.assertIn(
                    self.payload["source"]["quote"],
                    requests[0]["messages"][1]["content"],
                )
                second = tutor.ask(
                    self.book,
                    {
                        "conversation": first["id"],
                        "question": "再举一个例子",
                        "source": {"quote": "不应替换原文"},
                    },
                )
                self.assertEqual(len(second["messages"]), 4)
                self.assertEqual(second["source"], first["source"])
                self.assertEqual(
                    requests[-1]["messages"][-1]["content"], "再举一个例子"
                )
                self.assertEqual(len(tutor.history("demo")), 1)
                self.assertEqual(tutor.history("other"), [])
                with self.assertRaises(tutor.TutorError):
                    tutor.conversation(first["id"], "other")
                self.assertEqual(
                    tutor.conversation(first["id"], "demo")["messages"],
                    second["messages"],
                )
        finally:
            http.shutdown()
            http.server_close()
            worker.join()

    def test_failure_retry_and_interrupted_recovery(self):
        with patch.object(
            tutor, "complete", side_effect=tutor.TutorError("示例服务失败")
        ):
            with self.assertRaises(tutor.TutorError) as error:
                tutor.ask(self.book, self.payload)
        ident = error.exception.conversation
        self.assertEqual(
            tutor.conversation(ident, "demo")["messages"][-1]["status"], "error"
        )
        with patch.object(tutor, "complete", return_value="示例重试成功 [1]"):
            result = tutor.ask(
                self.book, {"conversation": ident, "question": "重试", "retry": True}
            )
        self.assertEqual(len(result["messages"]), 2)
        self.assertEqual(result["messages"][-1]["status"], "ready")
        data = tutor.records()
        data["conversations"][0]["messages"][-1]["status"] = "generating"
        tutor.save(self.root / "ai-conversations.json", data)
        self.assertIn(
            "中断", tutor.conversation(ident, "demo")["messages"][-1]["error"]
        )
        self.assertFalse(tutor.ACTIVE)

    def test_model_html_is_offline_and_math_is_preserved(self):
        result = tutor.answer_html(
            "中文 **说明** $x^2$\n\n![图片](https://example.invalid/p.png)\n\n[链接](javascript:alert(1))\n\n<script>bad()</script>"
        )
        root = html.fromstring(result)
        self.assertIn("中文", root.text_content())
        self.assertFalse(
            root.xpath("//script|//img|//*[@src or @href or @onclick or @style]")
        )
        if tutor.shutil.which("pandoc"):
            self.assertTrue(root.xpath("//math"))

    def test_configuration_hides_credentials_and_rejects_unsafe_urls(self):
        with patch.dict(
            tutor.os.environ,
            {
                "AI_BASE_URL": "https://example.invalid/v1",
                "AI_API_KEY": "test-value-only",
            },
        ):
            self.assertNotIn("test-value-only", json.dumps(tutor.status()))
        for address in (
            "http://example.invalid/v1",
            "https://name:password@example.invalid",
            "https://example.invalid/v1?key=value",
        ):
            with patch.dict(tutor.os.environ, {"AI_BASE_URL": address}):
                self.assertFalse(tutor.status()["configured"])
        self.assertFalse((self.root / "ai-conversations.json").exists())

    def test_storage_failure_preserves_answer_and_releases_active_request(self):
        real_save = tutor.save
        calls = 0

        def failing_save(path, value):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("test storage failure")
            return real_save(path, value)

        with (
            patch.object(tutor, "save", side_effect=failing_save),
            patch.object(tutor, "complete", return_value="应能复制保留的回答"),
        ):
            result = tutor.ask(self.book, self.payload)
        self.assertEqual(result["messages"][-1]["content"], "应能复制保留的回答")
        self.assertIn("未能保存", result["storageWarning"])
        self.assertFalse(tutor.ACTIVE)
        with (
            patch.object(tutor, "save", side_effect=OSError("test storage failure")),
            patch.object(tutor, "complete") as provider,
        ):
            with self.assertRaises(tutor.TutorError):
                tutor.ask(self.book, self.payload)
            provider.assert_not_called()
        self.assertFalse(tutor.ACTIVE)

    def test_redirect_does_not_forward_credentials_or_book_text(self):
        calls = []

        class Redirect(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                calls.append(self.path)
                self.send_response(302)
                self.send_header(
                    "Location", f"http://127.0.0.1:{self.server.server_port}/unexpected"
                )
                self.send_header("Content-Length", "0")
                self.end_headers()

            def do_GET(self):
                calls.append(self.path)
                self.send_response(200)
                self.end_headers()

        http = ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
        worker = threading.Thread(target=http.serve_forever, daemon=True)
        worker.start()
        try:
            with patch.dict(
                tutor.os.environ,
                {
                    "AI_BASE_URL": f"http://127.0.0.1:{http.server_port}/v1",
                    "AI_API_KEY": "test-value-only",
                },
            ):
                with self.assertRaises(tutor.TutorError):
                    tutor.complete(
                        tutor.configuration(),
                        [{"role": "user", "content": "自编测试原文"}],
                    )
                self.assertEqual(calls, ["/v1/chat/completions"])
        finally:
            http.shutdown()
            http.server_close()
            worker.join()


if __name__ == "__main__":
    unittest.main()
