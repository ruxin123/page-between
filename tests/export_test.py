import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
import base64
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import book_import
import epub_export
import chapter_edit
from scripts.create_demo import make_epub, make_pdf, make_scan
from storage import save
from lxml import etree


class Export(unittest.TestCase):
    def test_odt_bookmark_artifacts_do_not_break_navigation_or_nested_headings(self):
        markdown = self.root / "outline.md"
        markdown.write_text(
            "# First\n\nOriginal paragraph.\n\n## Detail\n\nMore text.\n\n## Further\n\nFurther text.\n\n# Second\n\n[Return to first](#first)."
        )
        source = self.root / "outline.odt"
        subprocess.run(
            ["pandoc", str(markdown), "-t", "odt", "-o", str(source)],
            check=True,
            capture_output=True,
        )
        original = source.read_bytes()
        book = book_import.import_book(source)
        with zipfile.ZipFile(self.output(epub_export.build(book))) as archive:
            for name in archive.namelist():
                if name.endswith(".xhtml"):
                    doc = etree.fromstring(archive.read(name))
                    identifiers = doc.xpath("//@id")
                    self.assertEqual(len(identifiers), len(set(identifiers)))
                    self.assertFalse(
                        doc.xpath(
                            '//*[local-name()="nav"]//*[local-name()="span" and not(node())]'
                        )
                    )
        self.assertEqual(
            book_import.path_for(book["originalUrl"]).read_bytes(), original
        )

    def test_converted_export_rebuilds_embedded_images_without_changing_saved_content(
        self,
    ):
        pixel = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv1cAAAAASUVORK5CYII="
        )

        source = self.root / "embedded.html"
        source.write_text(
            '<h1>Original export sample</h1><p>Original paragraph.</p><img alt="Original image" src="data:image/png;base64,'
            + base64.b64encode(pixel).decode()
            + '"/>'
        )
        book = book_import.import_book(source)
        converted = self.root / "books" / book["id"] / "converted.epub"
        converted.write_bytes(b"old incomplete converted cache")
        result = epub_export.build(book)
        with zipfile.ZipFile(self.output(result)) as archive:
            images = [
                archive.read(name)
                for name in archive.namelist()
                if name.endswith(".png")
            ]
            self.assertIn(pixel, images)
            self.assertFalse(
                any(
                    b"../data:image" in archive.read(name)
                    for name in archive.namelist()
                    if name.endswith(".xhtml")
                )
            )
        self.assertEqual(converted.read_bytes(), b"old incomplete converted cache")
        self.assertEqual(
            book_import.path_for(book["originalUrl"]).read_bytes(), source.read_bytes()
        )

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
        book.update(
            chapter_edit.stage(
                book, {"action": "rename", "index": 1, "title": "手工调整的标题"}
            )
        )
        result = epub_export.build(book)
        exported = book_import.import_book(self.output(result))
        self.assertTrue(
            any(
                "手工调整的标题" in chapter["title"] for chapter in exported["chapters"]
            )
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

    def test_pdf_table_keeps_unicode_math_and_image_only_cells(self):
        original = self.root / "table-source.pdf"
        make_pdf(original)
        book = book_import.import_book(original, enabled=True)
        table = '<table><tr><th>字母</th><th>值</th></tr><tr><td rowspan="2">σ</td><td><eq>\\frac{1}{2}</eq></td></tr><tr><td>τ</td></tr></table>'
        blocks = [
            {"type": "table", "text": "old corrupted text", "tableHtml": table, "bbox": [0.1, 0.1, 0.8, 0.35]},
            {"type": "table", "text": "\t", "tableHtml": '<table><tr><td><img src="https://example.invalid/x.png"/></td></tr></table>', "bbox": [0.1, 0.1, 0.8, 0.35]},
            {"type": "table", "text": "", "bbox": [0.1, 0.1, 0.8, 0.35]},
            {"type": "equation", "text": r"\unknownsourcecommand{x}", "bbox": [0.1, 0.1, 0.8, 0.35]},
        ]
        target = self.root / "books" / book["id"] / "enhancement.json"
        save(target, {"1": {"blocks": blocks}})
        book["enrichmentUrl"] = book_import.url_for(target)
        before = target.read_bytes()
        result = epub_export.build(book, [1])
        self.assertEqual(result["fallbackObjects"], 3)
        with zipfile.ZipFile(self.output(result)) as archive:
            chapters = [etree.fromstring(archive.read(name)) for name in archive.namelist() if name.endswith(".xhtml")]
            content = "\n".join("".join(root.itertext()) for root in chapters)
            self.assertIn("σ", content)
            self.assertIn("τ", content)
            self.assertTrue(any(root.xpath('//*[local-name()="table"]//*[local-name()="mfrac"]') for root in chapters))
            self.assertEqual(sum(len(root.xpath('//*[local-name()="img" and @alt="原书表格"]')) for root in chapters), 2)
        self.assertEqual(target.read_bytes(), before)

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
        long_name = epub_export.filename("很长的中文书名😀" * 30, ".epub")
        self.assertLessEqual(len(long_name.encode("utf-8")), 240)
        self.assertTrue(long_name.endswith(".epub"))


if __name__ == "__main__":
    unittest.main()
