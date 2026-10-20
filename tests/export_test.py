import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import book_import
import epub_export
from scripts.create_demo import make_epub, make_pdf, make_scan
from storage import save
from lxml import etree


class Export(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patches = [
            patch.object(book_import, "BOOK_ROOT", self.root / "books"),
            patch.object(epub_export, "BOOK_ROOT", self.root / "books"),
            patch.object(epub_export, "CACHE", self.root / "cache"),
        ]
        for override in self.patches:
            override.start()

    def tearDown(self):
        for override in reversed(self.patches):
            override.stop()
        self.temp.cleanup()

    def output(self, result):
        target = self.root / "cache/exports" / result["id"]
        checker = os.environ.get("EPUBCHECK_JAR")
        if checker:
            checked = subprocess.run(
                ["java", "-jar", checker, str(target), "--failonwarnings"],
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
        return target

    def test_legacy_package_is_repaired_without_changing_original_or_content(self):
        source = self.root / "legacy.epub"
        make_epub(source)
        with zipfile.ZipFile(source) as archive:
            content = {name: archive.read(name) for name in archive.namelist()}
        content["META-INF/container.xml"] = (
            content["META-INF/container.xml"]
            .replace(b' version="1.0"', b"")
            .replace(b' media-type="application/oebps-package+xml"', b"")
        )
        content["OPS/book.opf"] = (
            content["OPS/book.opf"]
            .replace(
                b'<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>', b""
            )
            .replace(b' properties="mathml"', b"")
        )
        with zipfile.ZipFile(source, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, body in content.items():
                archive.writestr(name, body)
        original = source.read_bytes()
        book = book_import.import_book(source)
        result = epub_export.build(book)
        self.assertTrue(result["compatibilityUpdated"])
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(
            book_import.path_for(book["originalUrl"]).read_bytes(), original
        )
        output = self.output(result)
        with zipfile.ZipFile(output) as archive:
            self.assertEqual(archive.infolist()[0].filename, "mimetype")
            self.assertEqual(archive.infolist()[0].compress_type, zipfile.ZIP_STORED)
            self.assertFalse(archive.infolist()[0].extra)
            for name, body in content.items():
                if name not in {"META-INF/container.xml", "OPS/book.opf"}:
                    self.assertEqual(archive.read(name), body)
            package = etree.fromstring(archive.read("OPS/book.opf"))
            self.assertEqual(
                len(
                    package.xpath(
                        '//*[local-name()="meta"][@property="dcterms:modified"]'
                    )
                ),
                1,
            )
            self.assertTrue(
                package.xpath(
                    '//*[local-name()="item"][@id="chapter-2"][@properties="mathml"]'
                )
            )
        completed = output.read_bytes()
        self.assertFalse(epub_export.complete_package(output))
        self.assertEqual(output.read_bytes(), completed)

    def test_broken_native_package_is_not_published_as_a_successful_export(self):
        source = self.root / "sample.epub"
        make_epub(source)
        book = book_import.import_book(source)
        original = book_import.path_for(book["originalUrl"])
        with zipfile.ZipFile(original) as archive:
            content = {
                name: archive.read(name)
                for name in archive.namelist()
                if name != "OPS/nav.xhtml"
            }
        with zipfile.ZipFile(original, "w") as archive:
            for name, body in content.items():
                archive.writestr(name, body)
        with self.assertRaisesRegex(ValueError, "缺少正文或目录资源"):
            epub_export.build(book)
        self.assertEqual(list((self.root / "cache/exports").glob("*")), [])

    def test_native_epub_is_preserved_and_text_export_has_real_chapters(self):
        source = self.root / "sample.epub"
        for language in ("zh", "en"):
            make_epub(source, language=language)
            book = book_import.import_book(source)
            result = epub_export.build(book)
            self.assertFalse(result["compatibilityUpdated"])
            self.assertEqual(self.output(result).read_bytes(), source.read_bytes())
        source = self.root / "novel.txt"
        source.write_text(
            "第一章 起点\n\n这是第一章，价格 $100。\n\n第二章 继续\n\n这是第二章。"
        )
        book = book_import.import_book(source)
        result = epub_export.build(book)
        exported = book_import.import_book(self.output(result))
        self.assertTrue(
            any("第一章" in chapter["title"] for chapter in exported["chapters"])
        )
        with zipfile.ZipFile(self.output(result)) as archive:
            text = "".join(
                archive.read(name).decode()
                for name in archive.namelist()
                if name.endswith(".xhtml")
            )
        self.assertIn("$100", text)

    def test_enhanced_pdf_keeps_math_tables_images_and_returns_to_original_pages(self):
        original, scan = self.root / "native.pdf", self.root / "scan.pdf"
        make_pdf(original)
        make_scan(original, scan)
        book = book_import.import_book(scan)
        fixture = json.loads(
            (book_import.ROOT / "scripts/demo-enhancement.json").read_text()
        )
        fixture["2"]["blocks"][2]["text"] = (
            "Using Definition 1.1, compare the following values."
        )
        save(self.root / "books" / book["id"] / "enhancement.json", fixture)
        book["enrichmentUrl"] = book_import.url_for(
            self.root / "books" / book["id"] / "enhancement.json"
        )
        result = epub_export.build(book, [1, 2])
        self.assertFalse(result["fallbackPages"])
        with zipfile.ZipFile(self.output(result)) as archive:
            content = "".join(
                archive.read(name).decode()
                for name in archive.namelist()
                if name.endswith(".xhtml")
            )
            self.assertIn("<math", content)
            self.assertIn("<table", content)
            self.assertIn("<img", content)
            self.assertIn("pdf-page-2", content)
            self.assertIn('id="p1-b2"', content)
            self.assertIn('href="ch001.xhtml#p1-b2"', content)
            self.assertEqual(
                json.loads(archive.read("META-INF/page-between.json"))["sourceHash"],
                book["sourceHash"],
            )
        imported = book_import.import_book(self.output(result))
        self.assertEqual(imported["sourcePdfHash"], book["sourceHash"])
        self.assertEqual(
            [
                chapter.get("sourcePdfPage")
                for chapter in imported["chapters"]
                if chapter.get("sourcePdfPage")
            ],
            [1, 2],
        )

    def test_unrenderable_equation_uses_original_image_instead_of_raw_tex(self):
        original, scan = self.root / "native.pdf", self.root / "scan.pdf"
        make_pdf(original)
        make_scan(original, scan)
        book = book_import.import_book(scan)
        fixture = {
            "1": {
                "blocks": [
                    {
                        "type": "equation",
                        "text": r"\customunknownmacro{x}",
                        "bbox": [0.3, 0.4, 0.7, 0.5],
                    }
                ]
            }
        }
        target = self.root / "books" / book["id"] / "enhancement.json"
        save(target, fixture)
        book["enrichmentUrl"] = book_import.url_for(target)
        result = epub_export.build(book, [1])
        self.assertEqual(result["fallbackObjects"], 1)
        self.assertFalse(
            epub_export.failed_math(self.output(result), {"p1-b0": {"type": "image"}})
        )
        with zipfile.ZipFile(self.output(result)) as archive:
            text = "".join(
                archive.read(name).decode()
                for name in archive.namelist()
                if name.endswith(".xhtml")
            )
            self.assertIn('alt="LaTeX:', text)

    def test_unparsed_scan_preserves_page_image_and_tables_cannot_execute_html(self):
        native, scan = self.root / "native.pdf", self.root / "scan.pdf"
        make_pdf(native)
        make_scan(native, scan)
        book = book_import.import_book(scan)
        result = epub_export.build(book, [2])
        self.assertEqual(result["fallbackPages"], [2])
        self.assertEqual(epub_export.table_html(""), "")
        table = epub_export.table_html(
            '<table onclick="bad()"><tr><td><script>bad()</script>safe</td><td rowspan="2">x</td></tr></table>'
        )
        self.assertNotIn("script", table)
        self.assertNotIn("onclick", table)
        self.assertIn('rowspan="2"', table)
        self.assertEqual(epub_export.filename("../name/a", ".epub"), "_name_a.epub")


if __name__ == "__main__":
    unittest.main()
