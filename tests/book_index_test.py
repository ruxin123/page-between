import json
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import book_index
import book_import
import chapter_edit
import pdf_enhancement
from ai_tutor import source_for
from pdf_selection import utf16
from scripts.create_demo import make_epub, make_pdf, make_scan


class BookIndex(unittest.TestCase):
    def test_shared_epub_search_and_sources_follow_the_toc_sections(self):
        source = self.root / "shared.epub"
        make_epub(source)
        with zipfile.ZipFile(source) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        files["OPS/chapter-1.xhtml"] = (
            b'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Body</title></head><body><h1 id="part-1">First</h1><p id="unrelated-paragraph">Definition 1.1. Earlier material.</p><h2><span id="part-2"/>Second</h2><p>Theorem 2.1. Later material.</p></body></html>'
        )
        files["OPS/nav.xhtml"] = (
            '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter-1.xhtml#part-1">第一章</a></li><li><a href="chapter-1.xhtml#part-2">第二章</a></li></ol></nav></body></html>'.encode()
        )
        with zipfile.ZipFile(source, "w") as archive:
            for name, value in files.items():
                archive.writestr(name, value)
        book = book_import.import_book(source)
        first = book_index.search(book, "Definition 1.1")["results"][0]
        second = book_index.search(book, "Theorem 2.1")["results"][0]
        heading = next(
            unit for unit in book_index.text_units(book) if unit[2] == "Second"
        )
        self.assertEqual(first["position"]["fragment"], "part-1")
        self.assertEqual(second["position"]["fragment"], "part-2")
        self.assertEqual(heading[3]["fragment"], "part-2")
        self.assertTrue(second["citation"].endswith(" · 第二章"))
        normalized = source_for(
            book, {"quote": second["text"], "position": second["position"]}
        )
        self.assertEqual(normalized["citation"], second["citation"])
        before = book_index.search(
            book, "Definition 1.1", position=second["position"], previous_only=True
        )
        self.assertEqual(before["results"][0]["position"]["fragment"], "part-1")
        book["toc"][1]["fragment"] = "unrelated-paragraph"
        rebuilt = book_index.search(book, "Definition 1.1")["results"][0]
        self.assertEqual(rebuilt["position"]["fragment"], "unrelated-paragraph")

    def test_pdf_previous_scope_uses_reading_order_and_excludes_unknown_current_page(
        self,
    ):
        native = self.root / "columns.pdf"
        make_pdf(native)
        book = book_import.import_book(native)
        blocks = {
            "1": {
                "blocks": [
                    {
                        "type": "text",
                        "text": "Definition 1.1. Earlier left column material.",
                        "bbox": [0.1, 0.7, 0.45, 0.85],
                    },
                    {
                        "type": "text",
                        "text": "Definition 2.1. Later right column material.",
                        "bbox": [0.55, 0.1, 0.9, 0.25],
                    },
                ]
            }
        }
        with patch.object(book_index, "enrichment_data", return_value=blocks):
            earlier = book_index.search(
                book,
                "Definition 2.1",
                position={"index": 1, "blockOrder": 0, "pdfY": 0.8},
                previous_only=True,
            )
            self.assertEqual(earlier["results"], [])
            current = book_index.search(
                book,
                "Definition 1.1",
                position={"index": 1, "blockOrder": 1, "pdfY": 0.1},
                previous_only=True,
            )
            self.assertTrue(current["results"])
            self.assertEqual(current["results"][0]["position"]["blockOrder"], 0)
        book["parseEnabled"] = False
        first_page = book_index.search(
            book,
            "Definition 1.1",
            position={"index": 1, "pdfY": 0.95},
            previous_only=True,
        )
        self.assertEqual(first_page["results"], [])
        previous_page = book_index.search(
            book, "Definition 1.1", position={"index": 2}, previous_only=True
        )
        self.assertTrue(previous_page["results"])
        self.assertTrue(
            all(item["position"]["index"] == 1 for item in previous_page["results"])
        )

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.overrides = [
            patch.object(book_index, "CACHE", self.root / "cache"),
            patch.object(book_import, "BOOK_ROOT", self.root / "books"),
            patch.object(pdf_enhancement, "CACHE", self.root / "cache/ocr-v4"),
        ]
        for override in self.overrides:
            override.start()

    def tearDown(self):
        for override in reversed(self.overrides):
            override.stop()
        self.temp.cleanup()

    def test_chinese_search_and_previous_knowledge_exclude_later_chapters(self):
        source = self.root / "sample.txt"
        source.write_text(
            "第一章 起点\n\n定义 1.1 连续函数的含义。\n\n定理 1.2 连续函数在闭区间有界。\n\n第二章 当前\n\n这里引用定理 1.2。\n\n第三章 后文\n\n定理 3.1 连续函数的其他性质。"
        )
        book = book_import.import_book(source)
        result = book_index.search(
            book, "连续函数 定理 1.2", position={"index": 2}, previous_only=True
        )
        self.assertFalse(result["status"]["partial"])
        self.assertTrue(result["results"])
        self.assertEqual(result["results"][0]["label"], "定理 1.2")
        self.assertTrue(
            all(item["position"]["index"] == 1 for item in result["results"])
        )
        self.assertNotIn("3.1", json.dumps(result, ensure_ascii=False))
        book_index.ensure(book)
        self.assertEqual(
            book_index.search(book, "定理 1.2")["results"][0]["label"], "定理 1.2"
        )

    def test_saved_pdf_selection_rebuilds_search_and_survives_cache_removal(self):
        native, scan = self.root / "native.pdf", self.root / "scan.pdf"
        make_pdf(native)
        make_scan(native, scan)
        book = book_import.import_book(scan)
        self.assertEqual(book_index.search(book, "durable")["status"]["covered"], 0)
        with patch.object(
            pdf_enhancement,
            "recognize",
            side_effect=AssertionError("No OCR during search"),
        ):
            for page in (1, 2):
                pdf_enhancement.save_selection(
                    book,
                    page,
                    {
                        "page": page,
                        "width": 540,
                        "height": 740,
                        "engine": "tesseract-eng",
                        "lines": [
                            {
                                "text": f"Theorem 9.{page}. Durable selection text.",
                                "bbox": [0.1, 0.2, 0.8, 0.3],
                            }
                        ],
                    },
                )
                result = book_index.search(book, "durable")
                self.assertEqual(result["status"]["covered"], page)
                self.assertEqual(len(result["results"]), page)
            earlier = book_index.search(
                book, "durable", position={"index": 2}, previous_only=True
            )
            self.assertEqual(len(earlier["results"]), 1)
            self.assertEqual(
                earlier["results"][0]["position"], {"index": 1, "pdfY": 0.2}
            )
            shutil.rmtree(book_index.CACHE)
            rebuilt = book_index.search(book, "durable")
            self.assertEqual(rebuilt["status"]["covered"], 2)
            self.assertEqual(len(rebuilt["results"]), 2)
            book["language"] = "zh"
            self.assertEqual(book_index.search(book, "durable")["status"]["covered"], 0)

    def test_native_epub_and_pdf_and_scan_coverage_are_distinct(self):
        source = self.root / "sample.epub"
        make_epub(source)
        book = book_import.import_book(source)
        self.assertTrue(book_index.search(book, "页")["results"])
        native, scan = self.root / "native.pdf", self.root / "scan.pdf"
        make_pdf(native)
        make_scan(native, scan)
        book = book_import.import_book(native)
        result = book_index.search(book, "Definition 1.1")
        self.assertEqual(result["status"]["covered"], 4)
        self.assertEqual(result["results"][0]["label"], "Definition 1.1")
        earlier = book_index.search(
            book,
            "Definition 1.1",
            position={"index": 2, "anchor": None},
            previous_only=True,
        )
        self.assertTrue(earlier["results"])
        book = book_import.import_book(scan)
        self.assertEqual(book_index.search(book, "Definition")["status"]["covered"], 0)
        with patch.object(
            book_index,
            "enrichment_data",
            return_value={
                "1": {
                    "blocks": [
                        {
                            "type": "text",
                            "text": "Definition 1.1. A function has one output.",
                            "bbox": [0.1, 0.2, 0.9, 0.3],
                        }
                    ]
                }
            },
        ):
            book["enhancementRevision"] = 2
            result = book_index.search(book, "Definition 1.1")
            self.assertEqual(result["status"]["covered"], 1)
            self.assertTrue(result["status"]["partial"])
            self.assertEqual(
                result["results"][0]["position"],
                {"index": 1, "pdfY": 0.2, "blockOrder": 0},
            )

    def test_reference_normalization_and_ambiguous_numbers_preserve_candidates(self):
        self.assertEqual(
            book_index.references("By Theorem 2.3. 定理 ２.３"),
            [("theorem:2.3", "Theorem 2.3"), ("theorem:2.3", "定理 2.3")],
        )
        self.assertIn("连续", book_index.tokens("连续函数"))
        self.assertNotIn('"', book_index.tokens('" OR DELETE'))
        for position in (
            {"index": -1},
            {"index": True},
            {"index": 1, "anchor": []},
            {"index": 1, "pdfY": float("nan")},
        ):
            with self.assertRaises(ValueError):
                book_index.search(
                    {"type": "pdf", "pages": 3},
                    "x",
                    position=position,
                    previous_only=True,
                )

    def test_manual_merge_rebases_saved_sources_and_previous_knowledge(self):
        source = self.root / "merge.txt"
        source.write_text(
            "第一章 起点\n定义 1.1 连续函数的含义。\n第二章 中途\n此前资料与😀。\n第三章 当前\n这里引用定义 1.1。"
        )
        book = book_import.import_book(source)
        old_position = {"index": 3, "sourceOffset": book["chapters"][2]["sourceOffset"]}
        book.update(chapter_edit.stage(book, {"action": "merge", "index": 2}))
        result = book_index.search(
            book, "定义 1.1", position=old_position, previous_only=True
        )
        self.assertTrue(result["results"])
        self.assertTrue(
            all(item["position"]["index"] == 1 for item in result["results"])
        )
        anchored = source_for(
            book,
            {"position": old_position, "quote": "这里引用定义 1.1。", "context": ""},
        )
        self.assertEqual(anchored["position"]["index"], 2)
        self.assertEqual(
            anchored["position"]["sourceOffset"], old_position["sourceOffset"]
        )

    def test_long_paragraph_previous_filter_uses_utf16_chunk_end(self):
        source = self.root / "long.txt"
        paragraph = (
            "定义 1.1 连续函数。😀" + "已读资料" * 600 + "未来定义 2.1 尚未读到。"
        )
        source.write_text("第一章 起点\n\n" + paragraph)
        book = book_import.import_book(source)
        start = book["chapters"][0]["sourceOffset"]
        position = {"index": 1, "sourceOffset": start + utf16(paragraph[:1850])}
        earlier = book_index.search(
            book, "定义 1.1", position=position, previous_only=True
        )
        self.assertTrue(earlier["results"])
        self.assertNotIn("未来定义", json.dumps(earlier, ensure_ascii=False))
        later = book_index.search(
            book, "未来定义 2.1", position=position, previous_only=True
        )
        self.assertTrue(
            all("未来定义" not in item["text"] for item in later["results"])
        )


if __name__ == "__main__":
    unittest.main()
