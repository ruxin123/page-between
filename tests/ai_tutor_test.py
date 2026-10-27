import json
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ai_tutor as tutor
from lxml import html


class Tutor(unittest.TestCase):
    def test_long_selection_is_rejected_without_cutting_a_formula(self):
        source = {**self.payload["source"], "quote": "x" * 5990 + r" $\frac{a+b}{c+d}$"}
        before = json.dumps(source)
        with self.assertRaisesRegex(tutor.TutorError, "超过 6000"):
            tutor.source_for(self.book, source)
        self.assertEqual(json.dumps(source), before)

    def test_shared_epub_source_uses_its_toc_section_instead_of_the_spine_label(self):
        book = {
            **self.book,
            "chapters": [{"title": "正文"}],
            "toc": [
                {"title": "第二章", "index": 1, "fragment": "part-2", "children": []}
            ],
        }
        source = {
            **self.payload["source"],
            "citation": "不采用客户端自填标题",
            "position": {"index": 1, "fragment": "part-2"},
        }
        self.assertEqual(
            tutor.source_for(book, source)["citation"], "《自编示例》 · 第二章"
        )
        source["position"]["fragment"] = "unknown"
        self.assertEqual(
            tutor.source_for(book, source)["citation"], "《自编示例》 · 正文"
        )
        source["position"]["resource"] = "/demo-data/books/demo/content/notes.xhtml"
        self.assertEqual(
            tutor.source_for(book, source)["citation"], "《自编示例》 · 原书附加内容"
        )

    def test_actual_nearby_text_is_saved_and_unprovided_citations_are_identified(self):
        quote = self.payload["source"]["quote"]
        payload = {
            **self.payload,
            "source": {
                **self.payload["source"],
                "context": "之前说明。\n" + quote + "\n尚未读到的文字。",
            },
        }
        with patch.object(
            tutor, "complete", return_value="依据 [2]。数学集合 $[7]$ 不作为来源。"
        ):
            first = tutor.ask(self.book, payload)
        message = first["messages"][-1]
        self.assertEqual(message["nearbyText"], "之前说明。\n" + quote)
        self.assertNotIn("citationWarning", message)
        with patch.object(
            tutor,
            "complete",
            return_value="模型误用了来源 [2]。数学 $[7]$ 不作为来源。",
        ):
            second = tutor.ask(
                self.book,
                {**self.payload, "source": {**self.payload["source"], "context": ""}},
            )
        self.assertEqual(second["messages"][-1]["status"], "ready")
        self.assertIn("[2]", second["messages"][-1]["citationWarning"])
        self.assertNotIn("[7]", second["messages"][-1]["citationWarning"])
        with patch.object(tutor, "complete", return_value="位置明确的答复。[2]"):
            exact = tutor.ask(
                self.book,
                {
                    **payload,
                    "source": {
                        **payload["source"],
                        "contextBefore": "重复选段实际位于乙段之后。",
                    },
                },
            )
        self.assertEqual(
            exact["messages"][-1]["nearbyText"], "重复选段实际位于乙段之后。"
        )

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patches = [
            patch.object(tutor, "DATA", self.root),
            patch.object(tutor.service_settings, "ROOT", self.root),
            patch.object(tutor.service_settings, "CONFIG", self.root / "services.json"),
            patch.object(tutor, "ACTIVE", set()),
            patch.object(tutor, "CANCELLATIONS", {}),
            patch.dict(
                tutor.service_settings.os.environ,
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
                tutor.service_settings.os.environ,
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

    def test_source_preview_renders_objects_without_changing_original_text(self):
        equation = r"\frac{x^2}{1+x}"
        table = "x\tf(x)\n0\t0\n1\t1"
        quote = (
            "**原文**\n\n" + equation + "\n\n" + table
            + "\n\n" + r"Observe $\varnothing \sim \varnothing$ on an empty set."
        )
        payload = {"quote": quote, "position": {"index": 1}}
        before = json.dumps(payload, ensure_ascii=False)
        book = {**self.book, "type": "pdf", "pages": 1}
        blocks = [
            {"type": "equation", "text": equation},
            {"type": "table", "text": table},
        ]
        with patch.object(tutor, "page_enrichment", return_value=blocks), patch.object(
            tutor, "complete", side_effect=AssertionError("Preview must stay local")
        ):
            result = html.fromstring(tutor.source_preview(book, payload))
        self.assertEqual(json.dumps(payload, ensure_ascii=False), before)
        if tutor.shutil.which("pandoc"):
            self.assertTrue(result.xpath("//strong"))
            self.assertTrue(result.xpath("//math//mfrac"))
            self.assertTrue(result.xpath('//annotation[contains(text(), "varnothing")]'))
            self.assertEqual(len(result.xpath("//table//tr")), 3)

    def test_source_preview_bounds_and_untrusted_markup(self):
        for quote in (None, {}, "", "x" * 6001):
            with self.assertRaises(tutor.TutorError):
                tutor.source_preview(
                    self.book, {"quote": quote, "position": {"index": 1}}
                )
        with self.assertRaises(tutor.TutorError):
            tutor.source_preview(
                self.book, {"quote": "text", "position": {"index": 0}}
            )
        quote = (
            '<script>bad()</script>\n\n'
            '![remote](https://example.invalid/p.png)\n\n$x^2$'
        )
        result = html.fromstring(
            tutor.source_preview(self.book, {"quote": quote, "position": {"index": 1}})
        )
        self.assertFalse(
            result.xpath("//script|//img|//*[@src or @href or @onclick or @style]")
        )

    def test_formula_only_text_uses_the_same_layout_as_neighboring_equations(self):
        if not tutor.shutil.which("pandoc"):
            self.skipTest("Pandoc required")
        texts = [r"D_1=\{x\in D\mid x\text{ has a predecessor}\};",
                 r"$D_2=\{x\in D\mid x\text{ has no predecessor}\}$;",
                 r"D_3=\{x\in D\mid x\text{ has infinite ancestry}\}."]
        payload = {"quote": "\n\n".join(texts), "position": {"index": 1}}
        before = json.dumps(payload)
        blocks = [{"type": kind, "text": text} for kind, text in
                  zip(["equation", "text", "equation"], texts)]
        with patch.object(tutor, "page_enrichment", return_value=blocks):
            result = html.fromstring(tutor.source_preview(
                {**self.book, "type": "pdf", "pages": 1}, payload))
        self.assertEqual(len(result.xpath('//*[@class="source-equations"]/p/math[@display="block"]')), 3)
        self.assertEqual(len(result.xpath('//math//msub')), 3)
        self.assertFalse(result.xpath('//p[not(math)]'))
        self.assertEqual(json.dumps(payload), before)

    def test_circled_operators_vertical_arrows_and_broken_source_math(self):
        if not tutor.shutil.which("pandoc"):
            self.skipTest("Pandoc required")
        quote = (
            r"$x\textcircled{\times}y$ and $x\textcircled{+}y$"
            + "\n\n" + r"$$\begin{array}{c}D\to E\\h\Bigg\downarrow\\F\end{array}$$"
        )
        original = quote
        result = html.fromstring(tutor.answer_html(quote, source=True))
        self.assertEqual(len(result.xpath('//math')), 3)
        self.assertTrue(result.xpath('//mo[text()="⊗"]'))
        self.assertTrue(result.xpath('//mo[text()="⊕"]'))
        self.assertTrue(result.xpath('//mo[text()="↓"]'))
        self.assertEqual(quote, original)
        broken = r"Before $\overline{x$ after."
        result = html.fromstring(tutor.answer_html(broken, source=True))
        self.assertTrue(result.xpath('//*[@class="math-unavailable"]'))
        self.assertIn("Before", result.text_content())
        self.assertIn("after.", result.text_content())
        self.assertNotIn(r"\overline", result.text_content())
        answer = html.fromstring(tutor.answer_html(broken))
        self.assertTrue(answer.xpath('//code[@class="math-unavailable"]'))

    def test_table_symbols_math_merged_cells_and_safe_images(self):
        if not tutor.shutil.which("pandoc"):
            self.skipTest("Pandoc required")
        markup = '<table onclick="bad()"><tr><th>字母</th><th>值</th></tr><tr><td rowspan="2">σ</td><td><eq>\\frac{x}{y}</eq></td></tr><tr><td>τ<img src="https://example.invalid/x.png"/><script>bad()</script></td></tr></table>'
        block = {"type": "table", "text": "字母\t值\nσ\t\\frac{x}{y}\nτ", "tableHtml": markup}
        payload = {"quote": block["text"], "position": {"index": 1}}
        before = json.dumps(payload)
        with patch.object(tutor, "page_enrichment", return_value=[block]):
            result = html.fromstring(tutor.source_preview({**self.book, "type": "pdf", "pages": 1}, payload))
        self.assertTrue(result.xpath('//td[@rowspan="2" and text()="σ"]'))
        self.assertTrue(result.xpath('//math//mfrac'))
        self.assertIn("τ", result.text_content())
        self.assertFalse(result.xpath('//script|//img|//*[@src or @href or @onclick]'))
        self.assertNotIn("bad()", result.text_content())
        self.assertEqual(json.dumps(payload), before)
        block = {"type": "table", "text": "name\tvalue\nabsolute\t$|x|$"}
        with patch.object(tutor, "page_enrichment", return_value=[block]):
            result = html.fromstring(tutor.source_preview({**self.book, "type": "pdf", "pages": 1}, {"quote": block["text"], "position": {"index": 1}}))
        self.assertEqual(result.xpath('//math//mo/text()'), ['|', '|'])

    def test_cross_page_preview_keeps_both_formula_sources_and_range(self):
        book = {**self.book, "type": "pdf", "pages": 3}
        quote = "first\n\nx^2\n\nsecond\n\ny^2"
        position = {"index": 1, "endIndex": 2}
        payload = {"quote": quote, "position": position}
        with patch.object(tutor, "page_enrichment", return_value=[
            {"type": "equation", "text": "x^2"}, {"type": "equation", "text": "y^2"}
        ]) as blocks:
            result = html.fromstring(tutor.source_preview(book, payload))
        blocks.assert_called_once_with(book, 1, 2)
        self.assertEqual(len(result.xpath('//math//msup')), 2)
        self.assertEqual(tutor.source_for(book, payload)["citation"], "《自编示例》 · PDF 第 1–2 页")
        self.assertEqual(payload["quote"], quote)
        for end in [0, 4, True, "2"]:
            with self.assertRaises(tutor.TutorError):
                tutor.source_for(book, {"quote": quote, "position": {"index": 1, "endIndex": end}})

    def test_math_styles_and_spaced_array_columns_render_without_rewriting_code(self):
        if not tutor.shutil.which("pandoc"):
            self.skipTest("Pandoc is required for math rendering")
        equation = r"h(t)=\left\{\begin{array}{l l}t^2&\text{if }t\ge0\\0&\text{if }t<0\end{array}\right."
        literal = r"\begin{array}{l l}"
        quote = r"**说明** $\mathbf{v}:\mathbb{R}\to\mathbb{R}$" + "\n\n" + equation + "\n\n`" + literal + "`"
        payload = {"quote": quote, "position": {"index": 1}}
        before = json.dumps(payload)
        with patch.object(tutor, "page_enrichment", return_value=[{"type":"equation","text":equation}]), patch.object(tutor, "complete", side_effect=AssertionError("Preview stays local")):
            result = html.fromstring(tutor.source_preview({**self.book,"type":"pdf","pages":1},payload))
        self.assertEqual(json.dumps(payload),before)
        self.assertTrue(result.xpath("//math//mstyle"))
        self.assertFalse(result.xpath("//math//span"))
        self.assertEqual(len(result.xpath('//math[@display="block"]//mtable/mtr')),2)
        self.assertEqual(result.xpath("string(//code)"),literal)

    def test_old_answer_html_is_repaired_without_changing_saved_content(self):
        if not tutor.shutil.which("pandoc"):
            self.skipTest("Pandoc is required for math rendering")
        content = r"旧回答 $\mathbf{w}=\mathbb{R}^2$"
        with patch.object(tutor,"complete",return_value=content):
            created=tutor.ask(self.book,self.payload)
        data=tutor.records();message=data['conversations'][0]['messages'][-1]
        message.pop('htmlVersion',None);message['html']='<p>Old broken display cache</p>'
        tutor.save(tutor.DATA/'ai-conversations.json',data)
        before=(tutor.DATA/'ai-conversations.json').read_bytes()
        with patch.object(tutor,"complete",side_effect=AssertionError("Reading history must not call the model")):
            result=tutor.conversation(created['id'],self.book['id'])
        self.assertEqual(result['messages'][-1]['content'],content)
        self.assertIn('<mstyle',result['messages'][-1]['html'])
        self.assertEqual(result['messages'][-1]['htmlVersion'],tutor.HTML_VERSION)
        self.assertEqual((tutor.DATA/'ai-conversations.json').read_bytes(),before)

    def test_formula_spacing_and_duplicate_page_numbers_are_display_only(self):
        if not tutor.shutil.which('pandoc'):
            self.skipTest('Pandoc required')
        equations = [r'p\text{ and }q\text{ continuous}\tag{23}', "p\\sim q\\tag{24'}"]
        quote = equations[0] + '\n\n(23)\n\n' + equations[1] + '\n\n(24’)'
        with patch.object(tutor,'page_enrichment',return_value=[{'type':'equation','text':e} for e in equations]):
            result=html.fromstring(tutor.source_preview({**self.book,'type':'pdf','pages':1},{'quote':quote,'position':{'index':1}}))
        self.assertFalse(result.xpath('//ol|//li'))
        self.assertTrue(result.xpath('//mspace[@width]'))
        self.assertEqual(result.xpath('//mtext[text()="(23)"]/text()'),['(23)'])
        self.assertIn("(24')", [t.replace('’', "'") for t in result.xpath('//mtext/text()')])

    def test_configuration_hides_credentials_and_rejects_unsafe_urls(self):
        with patch.dict(
            tutor.service_settings.os.environ,
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
            with patch.dict(
                tutor.service_settings.os.environ, {"AI_BASE_URL": address}
            ):
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
                tutor.service_settings.os.environ,
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

    def test_streaming_transport_exposes_partial_text_and_can_be_stopped(self):
        sent = []

        class Provider(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                sent.append(body)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                try:
                    for part in ["从定义开始", "，然后推导结论。[3]"]:
                        self.wfile.write(
                            (
                                "data: "
                                + json.dumps(
                                    {"choices": [{"delta": {"content": part}}]}
                                )
                                + "\n\n"
                            ).encode()
                        )
                        self.wfile.flush()
                        time.sleep(0.03)
                    self.wfile.write(b"data: [DONE]\n\n")
                except (BrokenPipeError, ConnectionResetError):
                    pass

        http = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        worker = threading.Thread(target=http.serve_forever, daemon=True)
        worker.start()
        try:
            with patch.dict(
                tutor.service_settings.os.environ,
                {"AI_BASE_URL": f"http://127.0.0.1:{http.server_port}/v1"},
            ):
                progress = []
                answer = tutor.complete(
                    tutor.configuration(),
                    [{"role": "user", "content": "示例"}],
                    on_delta=progress.append,
                )
                self.assertEqual(progress[0], "从定义开始")
                self.assertEqual(progress[-1], answer)
                self.assertTrue(sent[0]["stream"])
                control = {"event": threading.Event(), "socket": None}
                with self.assertRaises(tutor.TutorError):
                    tutor.complete(
                        tutor.configuration(),
                        [],
                        on_delta=lambda text: control["event"].set(),
                        control=control,
                    )
        finally:
            http.shutdown()
            http.server_close()
            worker.join()

    def test_previous_references_are_saved_per_answer_and_cancellation_keeps_partial(
        self,
    ):
        book = {
            **self.book,
            "url": "/example",
            "chapters": [{"title": "第一章"}, {"title": "第二章"}],
        }
        source = {
            **self.payload["source"],
            "position": {"index": 2, "anchor": {"index": 4}},
        }
        entry = {
            "id": 1,
            "label": "定义 1.1",
            "text": "函数每个输入只有一个输出。",
            "citation": "自编示例 · 第一章",
            "position": {"index": 1},
        }
        captured = []

        def provider(config, prompt, **options):
            captured.extend(prompt)
            options["on_delta"]("保留这段尚未完成的回答")
            tutor.cancel(ident[0], book["id"])
            return "不应覆盖停止状态"

        prepared = tutor.prepare(book, {**self.payload, "source": source})
        ident = [prepared[1]]
        with (
            patch.object(
                tutor.book_index,
                "search",
                return_value={
                    "status": {
                        "covered": 2,
                        "total": 2,
                        "unit": "章",
                        "partial": False,
                    },
                    "results": [entry],
                },
            ) as search,
            patch.object(tutor, "complete", side_effect=provider),
        ):
            result = tutor.finish(book, prepared)
        self.assertTrue(search.call_args.kwargs["previous_only"])
        self.assertEqual(search.call_args.kwargs["position"], source["position"])
        self.assertIn("[3] 本书此前资料", captured[1]["content"])
        message = result["messages"][-1]
        self.assertEqual(message["status"], "stopped")
        self.assertEqual(message["content"], "保留这段尚未完成的回答")
        self.assertEqual(message["references"][0]["number"], 3)
        self.assertEqual(
            tutor.conversation(result["id"], book["id"])["messages"][-1]["references"][
                0
            ]["position"],
            {"index": 1},
        )
        self.assertFalse(tutor.ACTIVE)
        self.assertFalse(tutor.CANCELLATIONS)


if __name__ == "__main__":
    unittest.main()
