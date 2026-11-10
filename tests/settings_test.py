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
    def test_local_model_addresses_are_bounded_to_local_hosts(self):
        for host in ["localhost", "127.0.0.1", "10.1.2.3", "192.168.1.20", "172.31.1.1", "reader.local"]:
            self.assertTrue(settings.local_host(host))
            config = settings.validated("ai", {"baseUrl": "http://" + host + ":1234/v1", "model": "local", "key": ""}, require_key=True)
            self.assertEqual(config["model"], "local")
        for host in ["192.test.168.1.1", "172.32.0.1", "010.0.0.1", "example.org"]:
            self.assertFalse(settings.local_host(host))
            with self.assertRaises(settings.SettingsError):
                settings.validated("ai", {"baseUrl": "http://" + host + "/v1", "model": "local", "key": ""})
    def test_model_discovery_reads_actual_server_and_preserves_saved_configuration(self):
        for service, config in [([], {}), (None, {}), ("ai", []), ("mineru", {})]:
            with self.assertRaises(settings.SettingsError): settings.available_models(service, config)
        received = []
        reply = {"body": {"data": [{"id": "model-b"}, {"id": "model-a"}, {"id": "model-a"}]}, "redirect": False}
        class Models(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                received.append((self.path, self.headers.get("Authorization")))
                if reply["redirect"]:
                    self.send_response(302); self.send_header("Location", "/unexpected"); self.end_headers(); return
                body = json.dumps(reply["body"]).encode()
                self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Models)
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        try:
            config = {**self.config, "baseUrl": f"http://127.0.0.1:{server.server_port}/v1"}
            settings.update("ai", config)
            before = settings.CONFIG.read_bytes()
            self.assertEqual(settings.available_models("ai", {**config, "model": "", "key": ""})["models"], ["model-a", "model-b"])
            self.assertEqual(received[-1], ("/v1/models", "Bearer example-credential"))
            self.assertEqual(settings.available_models("translation", {"useChatModel": True})["models"], ["model-a", "model-b"])
            self.assertEqual(settings.CONFIG.read_bytes(), before)
            reply["body"] = {"data": []}
            self.assertEqual(settings.available_models("ai", config)["models"], [])
            for invalid in [{}, {"data": [None]}, {"data": [{"id": "x" * 201}]}]:
                reply["body"] = invalid
                with self.assertRaises(settings.SettingsError): settings.available_models("ai", config)
            reply["redirect"] = True
            with self.assertRaises(settings.SettingsError): settings.available_models("ai", config)
            self.assertNotIn("/unexpected", [path for path, _ in received])
            self.assertEqual(settings.CONFIG.read_bytes(), before)
        finally:
            server.shutdown(); server.server_close(); worker.join()

    def test_custom_prompts_persist_independently_when_translation_inherits_model(self):
        settings.update("ai", {**self.config, "customPrompt": "先给提示\n再展开证明"})
        settings.update("translation", {"useChatModel": True, "customPrompt": "保留术语的英文原词"})
        chat = settings.ai_configuration()
        translated = settings.ai_configuration("translation")
        self.assertEqual(chat["customPrompt"], "先给提示\n再展开证明")
        self.assertEqual(translated["customPrompt"], "保留术语的英文原词")
        self.assertEqual(chat["key"], translated["key"])
        self.assertEqual(settings.personalized_prompt("format rules", translated), "用户偏好：\n保留术语的英文原词\n\nformat rules")
        settings.update("ai", {**self.config, "key": ""})
        self.assertEqual(settings.public_settings()["services"]["ai"]["customPrompt"], chat["customPrompt"])
        settings.update("ai", {**self.config, "key": "", "customPrompt": ""})
        self.assertEqual(settings.ai_configuration()["customPrompt"], "")

    def test_custom_prompt_limits_reject_before_writing_configuration(self):
        settings.update("ai", self.config)
        before = settings.CONFIG.read_bytes()
        for value in [None, [], "x" * 4001, "invalid\x00"]:
            with self.assertRaises(settings.SettingsError):
                settings.update("ai", {**self.config, "customPrompt": value})
            self.assertEqual(settings.CONFIG.read_bytes(), before)

    def test_image_capability_is_explicit_persistent_and_does_not_change_credentials(
        self,
    ):
        settings.update("ai", self.config)
        reference = settings.preferences()["services"]["ai"]["key"]
        self.assertFalse(settings.ai_configuration()["supportsImages"])
        result = settings.update(
            "ai", {**self.config, "key": "", "supportsImages": True}
        )
        self.assertTrue(result["services"]["ai"]["supportsImages"])
        self.assertEqual(settings.preferences()["services"]["ai"]["key"], reference)
        settings.update("ai", {**self.config, "key": ""})
        self.assertTrue(settings.ai_configuration()["supportsImages"])
        with self.assertRaises(settings.SettingsError):
            settings.update("ai", {**self.config, "supportsImages": "true"})

    def test_status_does_not_read_credentials_in_the_background(self):
        import ai_tutor

        settings.update("ai", self.config)
        settings.legacy_key.reset_mock()
        self.assertTrue(ai_tutor.status()["configured"])
        settings.legacy_key.assert_not_called()

    def test_translation_can_inherit_or_use_its_own_file_model(self):
        with self.assertRaises(settings.SettingsError):
            settings.ai_configuration("translation")
        settings.update("ai", self.config)
        inherited = settings.ai_configuration("translation")
        self.assertEqual(inherited["key"], "example-credential")
        self.assertEqual(inherited["model"], "example-model")
        settings.update("translation", {**self.config, "model": "translation-model", "key": "translation-credential", "useChatModel": False, "provider": "ai"})
        self.assertEqual(settings.ai_configuration("translation")["key"], "translation-credential")
        self.assertEqual(settings.ai_configuration("translation")["model"], "translation-model")
        self.assertEqual(settings.ai_configuration()["key"], "example-credential")
        settings.update("translation", {**self.config, "model": "translation-model", "key": "", "useChatModel": True, "provider": "ai"})
        self.assertEqual(settings.ai_configuration("translation")["model"], "example-model")
        settings.legacy_key.reset_mock()
        self.assertTrue(settings.public_settings()["services"]["translation"]["ready"])
        settings.legacy_key.assert_not_called()

    def test_google_needs_no_model_and_invalid_provider_is_rejected(self):
        import translation
        saved = settings.update("translation", {"baseUrl": "", "model": "", "key": "", "provider": "google", "useChatModel": True})
        self.assertTrue(saved["services"]["translation"]["ready"])
        self.assertEqual(translation.configuration()["provider"], "google")
        self.assertFalse(translation.status()["aiReady"])
        with self.assertRaises(ValueError):
            translation.configuration("ai")
        for value in [[], "other", None]:
            with self.assertRaises(settings.SettingsError):
                settings.update("translation", {"baseUrl": "", "model": "", "key": "", "provider": value})

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.secrets = {}
        self.overrides = [
            patch.object(settings, "CONFIG", self.root / "services.json"),
            patch.object(settings, "ROOT", self.root),
            patch.object(settings, "legacy_key", side_effect=lambda reference: self.secrets.get(reference)),
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
            self.assertIn("old-credential", settings.CONFIG.read_text())
            self.assertEqual(settings.CONFIG.stat().st_mode & 0o777, 0o600)

    def test_keep_replace_remove_and_missing_key_never_falls_back(self):
        settings.update("ai", self.config)
        original_ref = settings.preferences()["services"]["ai"]["key"]
        settings.update("ai", {**self.config, "key": "", "model": "new-model"})
        self.assertEqual(
            settings.preferences()["services"]["ai"]["key"], original_ref
        )
        settings.update("ai", {**self.config, "key": "replacement"})
        self.assertEqual(settings.effective("ai")["key"], "replacement")
        with patch.dict(os.environ, {"AI_API_KEY": "fallback-must-stay-disabled"}):
            result = settings.update(
                "ai", {**self.config, "key": "", "removeKey": True}
            )
            self.assertFalse(result["services"]["ai"]["hasKey"])
            with self.assertRaises(settings.SettingsError):
                settings.ai_configuration()
        self.assertEqual(self.secrets, {})

    def test_failed_file_write_preserves_old_config_and_credential(self):
        settings.update("ai", self.config)
        old_file, old_secrets = settings.CONFIG.read_bytes(), self.secrets.copy()
        with patch.object(settings, "save", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(settings.SettingsError, "未保存"):
                settings.update("ai", {**self.config, "key": "replacement"})
        self.assertEqual(settings.CONFIG.read_bytes(), old_file)
        self.assertEqual(self.secrets, old_secrets)
    def test_old_reference_migrates_once_and_failed_migration_preserves_it(self):
        reference = "ai:" + "a" * 32
        original = {"schema": 1, "services": {"ai": {"baseUrl": self.config["baseUrl"], "model": self.config["model"], "keyRef": reference}}}
        settings.save(settings.CONFIG, original)
        self.secrets[reference] = "legacy-value"
        before = settings.CONFIG.read_bytes()
        with patch.object(settings, "save", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                settings.effective("ai")
        self.assertEqual(settings.CONFIG.read_bytes(), before)
        self.assertEqual(settings.effective("ai")["key"], "legacy-value")
        self.assertNotIn("keyRef", settings.preferences()["services"]["ai"])
        settings.legacy_key.reset_mock()
        self.assertEqual(settings.effective("ai")["key"], "legacy-value")
        settings.legacy_key.assert_not_called()
        settings.save(settings.CONFIG, original)
        self.secrets.clear()
        with self.assertRaisesRegex(settings.SettingsError, "重新填写"):
            settings.effective("ai")
        settings.update("ai", self.config)
        self.assertEqual(settings.effective("ai")["key"], self.config["key"])

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
