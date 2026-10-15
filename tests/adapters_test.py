import base64
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import book_import
from book_import import import_book, safe_target, epub_metadata, defaults

PIXEL = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv1cAAAAASUVORK5CYII="
)


class Adapters(unittest.TestCase):
    def setUp(self):
        (book_import.ROOT / "tmp").mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(
            prefix="adapter-tests-",
            dir=book_import.ROOT / "tmp",
            ignore_cleanup_errors=True,
        )
        self.root = Path(self.temp.name)
        self.override = patch.object(book_import, "BOOK_ROOT", self.root / "books")
        self.override.start()

    def tearDown(self):
        self.override.stop()
        self.temp.cleanup()

    def epub(self, navigation=True):
        path = self.root / ("nav.epub" if navigation else "ncx.epub")
        files = {
            "META-INF/container.xml": '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
            "OPS/book.opf": '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>通用格式验证</dc:title><dc:creator>测试作者</dc:creator><dc:language>zh</dc:language></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="image" href="pic.png" media-type="image/png" properties="cover-image"/><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="one"/><itemref idref="two"/></spine></package>',
            "OPS/one.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body><h1 id="start">第一章</h1><p>正文<em>强调</em>。<img src="pic.png"/></p><a href="two.xhtml#note">注释</a></body></html>',
            "OPS/two.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head><body><h1>第二章</h1><p id="note">脚注正文</p></body></html>',
            "OPS/nav.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="one.xhtml#start">第一章</a><ol><li><a href="two.xhtml#note">脚注</a></li></ol></li><li><a href="two.xhtml">第二章</a></li></ol></nav></body></html>',
            "OPS/toc.ncx": '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint><navLabel><text>第一章</text></navLabel><content src="one.xhtml#start"/></navPoint><navPoint><navLabel><text>脚注</text></navLabel><content src="two.xhtml#note"/></navPoint></navMap></ncx>',
            "OPS/pic.png": PIXEL,
        }
        if not navigation:
            files["OPS/book.opf"] = files["OPS/book.opf"].replace(
                'properties="nav"', ""
            )
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("mimetype", "application/epub+zip")
            for name, value in files.items():
                archive.writestr(name, value)
        return path, files

    def test_epub3_preserves_resources_and_fragment_navigation(self):
        source, files = self.epub()
        book = import_book(source)
        self.assertFalse(book["parseEnabled"])
        self.assertEqual(book["tocSource"], "epub-nav")
        self.assertEqual(book["toc"][0]["children"][0]["index"], 2)
        self.assertEqual(book["toc"][0]["children"][0]["fragment"], "note")
        content = book_import.BOOK_ROOT / book["id"] / "content"
        self.assertEqual(
            (content / "OPS/one.xhtml").read_text(), files["OPS/one.xhtml"]
        )
        self.assertEqual((content / "OPS/pic.png").read_bytes(), PIXEL)
        self.assertEqual(len(book["chapters"]), 2)

    def test_epub2_reads_native_ncx(self):
        source, _ = self.epub(False)
        book = import_book(source)
        self.assertEqual(book["tocSource"], "epub-ncx")
        self.assertEqual(book["toc"][1]["fragment"], "note")

    def test_zip_cannot_escape_import_directory(self):
        source = self.root / "bad.epub"
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("../escaped.txt", "bad")
        with self.assertRaises(ValueError):
            import_book(source)
        self.assertFalse((self.root / "escaped.txt").exists())
        with self.assertRaises(ValueError):
            safe_target(self.root, "https://example.com/book", self.root)

    def test_txt_switch_and_encoding(self):
        source = self.root / "章节.txt"
        source.write_bytes(
            "第一卷 春\n第一章 来信\n正文一\n第二章 出发\n正文二".encode("gb18030")
        )
        book = import_book(source)
        self.assertTrue(book["parseEnabled"])
        self.assertEqual(len(book["chapters"]), 2)
        self.assertEqual(book["toc"][0]["title"], "第一卷 春")
        plain = import_book(source, enabled=False, ident="plain")
        self.assertEqual(len(plain["chapters"]), 1)
        self.assertEqual(plain["tocSource"], "text")
        self.assertFalse(defaults(".epub"))
        self.assertTrue(defaults(".pdf"))

    def test_txt_offsets_use_the_same_normalized_source_with_parse_on_and_off(self):
        source = self.root / "windows.txt"
        text = "  \r\n第一章 来信\r\n正文一\r\n第二章 出发\r\n正文二"
        source.write_bytes(text.encode("utf-8-sig"))
        normalized = text.replace("\r\n", "\n")
        parsed = import_book(source)
        plain = import_book(source, enabled=False, ident="whole")
        self.assertEqual(
            parsed["chapters"][1]["sourceOffset"], normalized.index("正文二")
        )
        self.assertEqual(
            plain["chapters"][0]["sourceOffset"], normalized.index("第一章")
        )
        content = book_import.ROOT / plain["contentUrl"].lstrip("/")
        self.assertNotIn("\r", json.loads(content.read_text())[0]["body"])

    def test_docx_keeps_embedded_image(self):
        from docx import Document

        image = self.root / "pixel.png"
        image.write_bytes(PIXEL)
        source = self.root / "图文教材.docx"
        doc = Document()
        doc.add_heading("第一章 原文", level=1)
        doc.add_paragraph("保留正文与插图。")
        doc.add_picture(str(image))
        doc.save(source)
        book = import_book(source)
        self.assertEqual(book["type"], "epub")
        self.assertFalse(book["parseEnabled"])
        content = book_import.BOOK_ROOT / book["id"] / "content"
        self.assertTrue(list(content.rglob("*.png")))

    def test_cbz_retains_numeric_page_order(self):
        source = self.root / "漫画.cbz"
        with zipfile.ZipFile(source, "w") as archive:
            for name in ["10.png", "2.png", "1.png"]:
                archive.writestr(name, PIXEL)
        book = import_book(source)
        self.assertEqual(book["layout"], "comic")
        self.assertEqual(len(book["chapters"]), 3)
        first = book_import.ROOT / book["chapters"][0]["url"].lstrip("/")
        self.assertIn("1.png", first.read_text())

    def test_other_common_formats(self):
        samples = {
            ".md": "# 第一章\n\n正文 **加粗**。",
            ".html": '<!doctype html><html><head><meta charset="utf-8"><title>HTML 试读</title></head><body><h1>第一章</h1><p>原文。</p></body></html>',
            ".rtf": r"{\rtf1\ansi\deff0 Reading sample\par Second paragraph}",
            ".fb2": '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>FB2 试读</book-title><lang>zh</lang></title-info></description><body><section><title><p>第一章</p></title><p>正文。</p></section></body></FictionBook>',
        }
        for extension, text in samples.items():
            source = self.root / ("sample" + extension)
            source.write_text(text)
            with self.subTest(extension=extension):
                book = import_book(source)
                self.assertEqual(book["type"], "epub")
                self.assertGreater(len(book["chapters"]), 0)


if __name__ == "__main__":
    unittest.main()
