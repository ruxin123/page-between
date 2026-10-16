import json
import os
import sys
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import service_settings as settings
from server import Handler


class Settings(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.secrets = {}
        self.overrides = [
            patch.object(settings, "CONFIG", self.root / "services.json"),
            patch.object(settings, "ROOT", self.root),
            patch.object(settings, "keychain", side_effect=self.keychain),
            patch.dict(
                os.environ,
                {name: "" for group in settings.ENV.values() for name in group},
            ),
        ]
        for override in self.overrides:
            override.start()
        self.config = {
            "baseUrl": "https://example.invalid/v1",
            "model": "example-model",
            "key": "example-credential",
        }

    def tearDown(self):
        for override in reversed(self.overrides):
            override.stop()
        self.temp.cleanup()

    def keychain(self, operation, account, value=None):
        if operation == "get":
            return self.secrets.get(account)
        if operation == "set":
            self.assertNotIn(account, self.secrets)
            self.secrets[account] = value
        if operation == "delete":
            self.secrets.pop(account, None)

    def test_legacy_migrates_on_save_and_app_overrides_environment(self):
        self.root.joinpath(".env").write_text(
            'AI_BASE_URL="https://example.invalid/v1"\nAI_MODEL=old-model\nAI_API_KEY=old-credential\n'
        )
        # Process variables deliberately take precedence over the compatibility file.
        with patch.dict(
            os.environ,
            {
                "AI_BASE_URL": self.config["baseUrl"],
                "AI_MODEL": "old-model",
                "AI_API_KEY": "old-credential",
            },
        ):
            self.assertEqual(settings.effective("ai")["source"], "environment")
            result = settings.update("ai", {**self.config, "key": ""})
            self.assertEqual(settings.ai_configuration()["key"], "old-credential")
            self.assertEqual(settings.ai_configuration()["model"], "example-model")
            self.assertEqual(result["services"]["ai"]["source"], "app")
            self.assertNotIn("old-credential", json.dumps(result))
            self.assertNotIn("old-credential", settings.CONFIG.read_text())
            self.assertEqual(len(self.secrets), 1)

    def test_keep_replace_remove_and_missing_key_never_falls_back(self):
        settings.update("ai", self.config)
        original_ref = settings.preferences()["services"]["ai"]["keyRef"]
        settings.update("ai", {**self.config, "key": "", "model": "new-model"})
        self.assertEqual(
            settings.preferences()["services"]["ai"]["keyRef"], original_ref
        )
        settings.update("ai", {**self.config, "key": "replacement"})
        self.assertEqual(list(self.secrets.values()), ["replacement"])
        with patch.dict(os.environ, {"AI_API_KEY": "fallback-must-stay-disabled"}):
            result = settings.update(
                "ai", {**self.config, "key": "", "removeKey": True}
            )
            self.assertFalse(result["services"]["ai"]["hasKey"])
            with self.assertRaises(settings.SettingsError):
                settings.ai_configuration()
        self.assertEqual(self.secrets, {})
        settings.update("ai", self.config)
        self.secrets.clear()
        with self.assertRaisesRegex(settings.SettingsError, "重新填写"):
            settings.ai_configuration()

    def test_failed_file_write_preserves_old_config_and_credential(self):
        settings.update("ai", self.config)
        old_file, old_secrets = settings.CONFIG.read_bytes(), self.secrets.copy()
        with patch.object(settings, "save", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(settings.SettingsError, "未保存"):
                settings.update("ai", {**self.config, "key": "replacement"})
        self.assertEqual(settings.CONFIG.read_bytes(), old_file)
        self.assertEqual(self.secrets, old_secrets)
        with patch.object(
            settings, "keychain", side_effect=settings.SettingsError("locked")
        ):
            with self.assertRaises(settings.SettingsError):
                settings.update("ai", {**self.config, "key": "replacement"})
        self.assertEqual(settings.CONFIG.read_bytes(), old_file)

    def test_validation_and_changed_destination_do_not_reuse_saved_key(self):
        settings.update("ai", self.config)
        old_file = settings.CONFIG.read_bytes()
        for address in [
            "http://remote.invalid/v1",
            "https://name:password@example.invalid/v1",
            "https://example.invalid/v1?key=hidden",
            "https://example.invalid:bad/v1",
            "https://example.invalid/v1\n",
        ]:
            with self.assertRaises(settings.SettingsError):
                settings.candidate("ai", {**self.config, "baseUrl": address})
        with self.assertRaisesRegex(settings.SettingsError, "重新填写"):
            settings.candidate(
                "ai", {**self.config, "baseUrl": "https://other.invalid/v1", "key": ""}
            )
        for payload in [
            {**self.config, "removeKey": "false"},
            {**self.config, "removeKey": True},
            {**self.config, "key": "line\nbreak"},
            {**self.config, "model": []},
        ]:
            with self.assertRaises(settings.SettingsError):
                settings.update("ai", payload)
        self.assertEqual(settings.CONFIG.read_bytes(), old_file)
        local = settings.candidate(
            "ai",
            {
                "baseUrl": "http://127.0.0.1:9090/v1",
                "model": "local-model",
                "removeKey": True,
            },
            require_key=True,
        )
        self.assertEqual(local["key"], "")

    def test_http_test_uses_draft_without_saving_or_sending_book_content(self):
        received = []

        class Provider(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                received.append(
                    json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                )
                body = b'{"choices":[{"message":{"content":"OK"}}]}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        class Quiet(Handler):
            def log_message(self, *args):
                pass

        provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        app = ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
        threads = [
            threading.Thread(target=http.serve_forever, daemon=True)
            for http in (provider, app)
        ]
        for thread in threads:
            thread.start()
        try:

            def post(route, payload):
                connection = HTTPConnection("127.0.0.1", app.server_port, timeout=10)
                connection.request(
                    "POST",
                    route,
                    json.dumps(payload),
                    {"Content-Type": "application/json"},
                )
                response = connection.getresponse()
                result = response.status, json.loads(response.read())
                connection.close()
                return result

            config = {
                "baseUrl": f"http://127.0.0.1:{provider.server_port}/v1",
                "model": "draft-model",
                "key": "",
            }
            status, result = post(
                "/api/settings/test", {"service": "ai", "config": config}
            )
            self.assertEqual(status, 200)
            self.assertIn("连接成功", result["message"])
            self.assertFalse(settings.CONFIG.exists())
            self.assertEqual(received[0]["model"], "draft-model")
            self.assertEqual(len(received[0]["messages"]), 1)
            self.assertNotIn("book", json.dumps(received))
            self.assertEqual(
                post("/api/settings/save", {"service": "ai", "config": config})[0], 200
            )
            self.assertEqual(settings.ai_configuration()["model"], "draft-model")
            status, result = post(
                "/api/settings/test",
                {
                    "service": "mineru",
                    "config": {
                        "baseUrl": "https://mineru.net/api/v4",
                        "model": "vlm",
                        "key": "sample-token",
                    },
                },
            )
            self.assertEqual(status, 200)
            self.assertFalse(result["verified"])
            self.assertEqual(len(received), 1)
        finally:
            for http in (provider, app):
                http.shutdown()
                http.server_close()
            for thread in threads:
                thread.join()


if __name__ == "__main__":
    unittest.main()
