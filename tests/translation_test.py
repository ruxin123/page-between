import json
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import translation as t
from storage import load, save


class Translation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.book = {"id": "original", "title": "原创测试", "type": "epub", "chapters": [{"title": "第一章"}]}
        self.payload = {"source": {"quote": "An injective map $f:A\\to B$.", "context": "Previously: one-to-one.\nAn injective map $f:A\\to B$.", "position": {"index": 1}}}
        self.config = {"url": "http://127.0.0.1:1/v1/chat/completions", "model": "test-model", "key": ""}
        self.patches = [patch.object(t, "BOOK_ROOT", self.root), patch.object(t, "JOBS", {}), patch.object(t, "configuration", return_value={**self.config, "provider": "ai"})]
        for p in self.patches:
            p.start()
        self.finished = threading.Event()

    def tearDown(self):
        deadline = time.monotonic() + 3
        while any(job.get("working") for job in t.JOBS.values()) and time.monotonic() < deadline:
            time.sleep(.01)
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def provider(self, config, messages, **kwargs):
        prompt = json.loads(messages[1]["content"])
        return json.dumps({"translation": "译文：" + prompt["original"], "detectedLanguage": "en", "explanation": "单射：不同输入对应不同输出。"})

    def wait(self, ident):
        end = time.monotonic() + 5
        while time.monotonic() < end:
            job = t.task(self.book, ident)
            if job["status"] != "running":
                return job
            time.sleep(.01)
        self.fail("translation did not finish")

    def test_translation_is_not_cached_or_written_until_explicit_favorite(self):
        original = json.dumps(self.payload)
        with patch.object(t.ai_tutor, "complete", side_effect=self.provider) as provider:
            result = self.wait(t.start(self.book, self.payload)["id"])["result"]
            self.assertIn("<math", result["html"])
            self.assertIn("$f:A\\to B$", result["translation"])
            self.assertFalse(t.history_path(self.book).exists())
            self.assertEqual(t.history(self.book), [])
            second = self.wait(t.start(self.book, self.payload)["id"])["result"]
            self.assertEqual(provider.call_count, 2)
            self.assertNotEqual(result["id"], second["id"])
            t.favorite(self.book, result["id"], True)
            stored = load(t.history_path(self.book), {})["items"][0]
            self.assertNotIn("html", stored)
            self.assertNotIn("cacheKey", stored)
            third = self.wait(t.start(self.book, self.payload)["id"])["result"]
            self.assertEqual(provider.call_count, 3)
            self.assertFalse(third["favorite"])
        self.assertEqual(len(t.history(self.book)), 1)
        self.assertEqual(t.lookup(self.book, result["id"])["translation"], result["translation"])
        self.assertEqual(json.dumps(self.payload), original)
        t.validate_history(self.book, self.root)
        t.favorite(self.book, result["id"], False)
        self.assertFalse(t.history_path(self.book).exists())

    def test_google_http_preserves_markdown_formula_code_and_sends_no_context(self):
        received = []
        class Provider(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                query = parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode())
                received.append(query["q"][0])
                value = {"sentences": [{"trans": query["q"][0].replace("Heading", "标题").replace("Value", "数值")}], "src": "en"}
                body = json.dumps(value).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body)
        http = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        thread = threading.Thread(target=http.serve_forever, daemon=True); thread.start()
        endpoint = f"http://127.0.0.1:{http.server_port}/translate_a/single"
        text = "## Heading\n\n- An injective map $f:A\\to B$.\n\n| Value | Formula |\n| --- | --- |\n| one | $x^2$ |\n\n`const x = 1`"
        try:
            with patch.object(t, "configuration", return_value={"provider": "google", "url": endpoint, "model": "Google 翻译"}), patch.object(t.google_translation, "ENDPOINT", endpoint):
                job = self.wait(t.start(self.book, {**self.payload, "text": text})["id"])
            self.assertEqual(job["status"], "ready", job)
            result = job["result"]
            self.assertIn("<math", result["html"])
            self.assertIn("<table", result["html"])
            self.assertIn("<h2", result["html"])
            self.assertIn("`const x = 1`", result["translation"])
            self.assertIn("$f:A\\to B$", result["translation"])
            self.assertNotIn("PBMZ", result["translation"])
            self.assertNotIn(self.payload["source"]["context"], received[0])
            self.assertEqual(result["provider"], "google")
            self.assertEqual(result["source"]["quote"], self.payload["source"]["quote"])
        finally:
            http.shutdown(); http.server_close(); thread.join()

    def test_google_receives_math_semantics_and_allows_symbol_reordering(self):
        original = r"An element $a$ of $G$ acts on the finite set $X = \{1,2,3\}$ according to a rule."
        expected = r"群 $G$ 中的元素 $a$ 按规则作用于有限集 $X=\{1,2,3\}$。"
        sent = []
        def google(text, *args):
            sent.append(text)
            return {"translation": expected, "detectedLanguage": "en", "explanation": ""}
        config = {"provider": "google", "url": "test", "model": "Google 翻译"}
        with patch.object(t, "configuration", return_value=config), patch.object(t.google_translation, "translate", side_effect=google):
            job = self.wait(t.start(self.book, {**self.payload, "text": original})["id"])
        self.assertEqual(sent, [original])
        self.assertEqual(job["status"], "ready", job)
        self.assertTrue(job["result"]["translation"].startswith("群 $G$ 中的元素 $a$"))
        self.assertIn(r"$X = \{1,2,3\}$", job["result"]["translation"])
        self.assertIn("<math", job["result"]["html"])
        self.assertEqual(job["result"]["textVersion"], t.GOOGLE_TEXT_VERSION)

    def test_google_validates_formula_content_not_positions(self):
        original = r"A map $f:A\to B$ sends $a$ to $b$; $a$ is fixed."
        translated = r"$a$ 固定。映射 $f:A \rightarrow B$ 将 $a$ 映到 $b$。"
        fixed = t.restore_google_math(original, translated)
        self.assertEqual(fixed, r"$a$ 固定。映射 $f:A\to B$ 将 $a$ 映到 $b$。")
        for bad in [r"$a$ 固定，映射 $f:A\to B$ 将 $a$ 映到 $c$。", translated + " $b$", translated.replace("$b$", "")]:
            with self.assertRaisesRegex(ValueError, "公式"):
                t.restore_google_math(original, bad)

    def test_old_automatic_history_is_removed_but_favorites_survive(self):
        with patch.object(t.ai_tutor, "complete", side_effect=self.provider):
            item = self.wait(t.start(self.book, self.payload)["id"])["result"]
        automatic = {**item, "cacheKey": "old-key"}
        favorite = {**item, "id": "f"*32, "favorite": True, "cacheKey": "old-favorite"}
        save(t.history_path(self.book), {"items": [automatic, favorite]})
        t.purge_automatic_history()
        self.assertEqual([row["id"] for row in t.history(self.book)], [favorite["id"]])
        self.assertNotIn("cacheKey", load(t.history_path(self.book), {})["items"][0])
        t.favorite(self.book, favorite["id"], False)
        self.assertFalse(t.history_path(self.book).exists())

    def test_google_never_splits_a_latex_expression_to_fit_a_chunk(self):
        formula = "$" + "x+" * 2200 + "x$"
        source = "Before. " + formula + " After."
        pieces = list(t.google_translation.chunks(source))
        self.assertEqual("".join(pieces), source)
        self.assertTrue(any(formula in piece for piece in pieces))

    def test_table_preview_and_provider_conversion_preserve_raw_formula(self):
        text = "Input\tRule\none\t$x^2$"
        source = {"quote": text, "context": "", "position": {"index": 1}, "kind": "table"}
        before = json.dumps(source)
        rendered = t.preview(self.book, source, text)
        self.assertIn("<table", rendered)
        self.assertIn("<math", rendered)
        def echo(text, *args):
            return {"translation": text, "detectedLanguage": "en", "explanation": ""}
        with patch.object(t, "configuration", return_value={"provider": "google", "url": "test", "model": "Google 翻译"}), patch.object(t.google_translation, "translate", side_effect=echo):
            job = self.wait(t.start(self.book, {"source": source})["id"])
        self.assertEqual(job["status"], "ready", job)
        self.assertIn("$x^2$", job["result"]["translation"])
        self.assertIn("<table", job["result"]["html"])
        self.assertEqual(json.dumps(source), before)

    def test_google_chunk_boundaries_and_formula_loss(self):
        text = "a " * 1995 + "PBMZabcN0END" + "b " * 3000
        parts = list(t.google_translation.chunks(text))
        self.assertEqual("".join(parts), text)
        self.assertEqual(sum("PBMZabcN0END" in part for part in parts), 1)
        with patch.object(t, "configuration", return_value={"provider": "google", "url": "test", "model": "Google 翻译"}), patch.object(t.google_translation, "translate", return_value={"translation": "dropped formula", "detectedLanguage": "en", "explanation": ""}):
            job = self.wait(t.start(self.book, self.payload)["id"])
        self.assertEqual(job["status"], "error")
        self.assertEqual(t.history(self.book), [])

    def test_formula_loss_fails_and_never_saves(self):
        with patch.object(t.ai_tutor, "complete", return_value='{"translation":"公式消失了"}'):
            job = self.wait(t.start(self.book, self.payload)["id"])
        self.assertEqual(job["status"], "error")
        self.assertIn("公式", job["error"])
        self.assertEqual(t.history(self.book), [])
        masked, formulas = t.mask_math(r"Costs $5 or $10. Then \(x+1\), $$y^2$$.")
        self.assertEqual(len(formulas), 2)
        code_masked, protected = t.mask_math("Use `<eq>x</eq>` and <eq>x^2</eq>.")
        restored = t.decode(json.dumps({"translation": code_masked}), protected)["translation"]
        self.assertEqual(restored, "Use `<eq>x</eq>` and $x^2$.")
        with self.assertRaises(ValueError):
            t.decode(json.dumps({"translation": masked + masked}), formulas)

    def test_cancel_and_book_scoping(self):
        entered, proceed = threading.Event(), threading.Event()
        def delayed(*args, **kwargs):
            entered.set(); proceed.wait(3)
            return self.provider(*args, **kwargs)
        with patch.object(t.ai_tutor, "complete", side_effect=delayed):
            job = t.start(self.book, self.payload)
            self.assertTrue(entered.wait(1))
            with self.assertRaises(ValueError):
                t.cancel({**self.book, "id": "other"}, job["id"])
            self.assertEqual(t.cancel(self.book, job["id"])["status"], "cancelled")
            proceed.set()
            end = time.monotonic() + 3
            while t.JOBS[job["id"]]["working"] and time.monotonic() < end:
                time.sleep(.01)
        self.assertEqual(t.history(self.book), [])
        self.assertNotIn("result", t.task(self.book, job["id"]))
        with self.assertRaises(ValueError):
            t.task(self.book, {})

    def test_language_selection_bounds_context_and_malformed_response(self):
        for payload in [{**self.payload, "sourceLanguage": "bad"}, {**self.payload, "targetLanguage": []}, {**self.payload, "text": "x" * 6001}, {**self.payload, "source": {**self.payload["source"], "position": {"index": 8}}}]:
            with self.assertRaises(ValueError):
                t.prepare(self.book, payload)
        payload = {**self.payload, "source": {**self.payload["source"], "context": "a"*4000 + self.payload["source"]["quote"] + "b"*10000, "contextBefore": "a"*4000}}
        prepared = t.prepare(self.book, payload)
        self.assertEqual(prepared["source"]["context"], "a"*800 + self.payload["source"]["quote"] + "b"*1200)
        for raw in ["not json", "[]", '{"translation":42}', '{"translation":"x","explanation":{}}']:
            with self.assertRaises(ValueError):
                t.decode(raw, {})
        self.assertEqual(t.decode('```json\n{"translation":"结果"}\n```', {})["translation"], "结果")

    def test_disk_failure_does_not_affect_translation_but_favorite_reports_error(self):
        with patch.object(t.ai_tutor, "complete", side_effect=self.provider), patch.object(t, "save", side_effect=OSError("disk")):
            result = self.wait(t.start(self.book, self.payload)["id"])["result"]
            self.assertNotIn("storageWarning", result)
            with self.assertRaises(OSError):
                t.favorite(self.book, result["id"], True)
        self.assertEqual(t.history(self.book), [])

    def test_safe_render_and_favorite_limit(self):
        with patch.object(t.ai_tutor, "complete", side_effect=self.provider):
            item = self.wait(t.start(self.book, self.payload)["id"])["result"]
        rows = [{**item, "id": f"{i:032x}", "favorite": True} for i in range(100)]
        save(t.history_path(self.book), {"items": rows})
        with self.assertRaisesRegex(ValueError, "100"):
            t.favorite(self.book, item["id"], True)
        self.assertEqual(len(t.history(self.book)), 100)
        malicious = t.public({**item, "translation": '<script>alert(1)</script> [bad](javascript:alert(1))'}, rendered=True)
        self.assertNotIn("<script>", malicious["html"])
        self.assertNotIn('href="javascript:', malicious["html"])


if __name__ == "__main__":
    unittest.main()
