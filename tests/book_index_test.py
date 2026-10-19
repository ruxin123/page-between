import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import book_index
import book_import
from scripts.create_demo import make_epub, make_pdf, make_scan


class BookIndex(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.overrides = [
            patch.object(book_index, "CACHE", self.root / "cache"),
            patch.object(book_import, "BOOK_ROOT", self.root / "books"),
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
                result["results"][0]["position"], {"index": 1, "pdfY": 0.2}
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


if __name__ == "__main__":
    unittest.main()
