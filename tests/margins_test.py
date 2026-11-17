import base64
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from PIL import Image
import book_margins as margins
import book_images
import book_import
from storage import load


class Margins(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.book = {"id":"original", "title":"Original", "type":"pdf", "pages":3}
        self.context = {"quote":"Original $x^2$", "position":{"index":2,"pdfY":.4}, "context":"not saved"}
        self.patches = [patch.object(margins, "BOOK_ROOT", self.root / "books"), patch.object(book_import,"BOOK_ROOT",self.root/"books"), patch.object(margins,"CACHE", self.root/"cache")]
        for value in self.patches: value.start()
    def tearDown(self):
        for value in reversed(self.patches): value.stop()
        self.temp.cleanup()
    def test_explicit_save_edit_delete_restore_and_idempotent_retry(self):
        request = {"id":"a"*32,"operation":"save","source":self.context}
        item = margins.change(self.book,request)
        self.assertNotIn("context",item["source"])
        self.assertEqual(item["source"]["position"],self.context["position"])
        margins.change(self.book,request)
        margins.change(self.book,{**request,"id":"c"*32})
        self.assertEqual(len(margins.listing(self.book)),1)
        margins.change(self.book,{"id":item["id"],"operation":"note","note":"A short thought"})
        margins.change(self.book,{"id":item["id"],"operation":"remove"})
        self.assertEqual(margins.listing(self.book),[])
        margins.change(self.book,{"id":item["id"],"operation":"restore"})
        self.assertEqual(margins.listing(self.book)[0]["note"],"A short thought")
        margins.validate(self.book,self.root/"books")
        for payload in [{**request,"id":"../outside"},{**request,"id":"b"*32,"source":{**self.context,"position":{"index":5}}},{"id":item["id"],"operation":"note","note":"x"*2001}]:
            with self.assertRaises(ValueError): margins.change(self.book,payload)
    def test_saving_a_table_preserves_leading_tabs_and_trailing_newlines(self):
        raw = "\tFirst\tSecond\nrow\t1\t2\n\n"
        item = margins.change(self.book, {"id": "e" * 32, "operation": "save", "source": {**self.context, "quote": raw, "kind": "table"}})
        self.assertEqual(item["source"]["quote"], raw)
        self.assertEqual(item["source"]["kind"], "table")

    def test_failed_large_export_removes_partial_file_and_preserves_saved_source(self):
        import random
        with Image.frombytes("RGB", (32, 32), random.Random(1).randbytes(32 * 32 * 3)) as image:
            body = io.BytesIO()
            image.save(body, format="PNG")
        source = {**self.context, "image": "data:image/png;base64," + base64.b64encode(body.getvalue()).decode()}
        margins.change(self.book, {"id": "a" * 32, "operation": "save", "source": source})
        with patch("translation.records", return_value={"items": []}), patch("ai_tutor.records", return_value={"conversations": []}), patch.object(margins, "MAX_EXPORT", 1000):
            with self.assertRaises(ValueError): margins.export(self.book, {}, "markdown")
        self.assertEqual(list((self.root / "cache/exports").glob("*")), [])
        self.assertEqual(len(margins.listing(self.book)), 1)

    def test_pdf_chapter_is_derived_from_source_page_and_destination_height(self):
        book = {**self.book, "toc": [{"title": "First", "index": 1}, {"title": "Later", "index": 2, "pdfY": .6}]}
        self.assertEqual(margins.chapter_for(book,{"index":2,"pdfY":.4}),"First")
        self.assertEqual(margins.chapter_for(book,{"index":2,"pdfY":.8}),"Later")

    def test_pdf_export_preserves_original_pages_outlines_annotations_and_exact_regions(self):
        from pypdf import PdfReader, PdfWriter
        from pypdf.annotations import Text
        from pypdf.generic import RectangleObject
        writer = PdfWriter()
        for rotation in (0, 90, 180, 270):
            page = writer.add_blank_page(600, 800)
            page.cropbox = RectangleObject([40, 100, 560, 700])
            page.rotate(rotation)
        writer.add_annotation(0, Text(rect=(50, 150, 70, 170), text="Existing note"))
        writer.add_outline_item("Original chapter", 0)
        original = self.root / "original.pdf"
        writer.write(original)
        before = original.read_bytes()
        book = {**self.book, "pages": 4, "originalUrl": "original.pdf"}
        rects = [{"page": page, "bbox": [.2, .2, .6, .24]} for page in range(1, 5)]
        source = {"quote": "Original $x^2$", "position": {"index": 1, "endIndex": 4, "pdfY": .2}, "rects": rects}
        margins.change(book, {"id": "a" * 32, "operation": "save", "source": source})
        margins.change(book, {"id": "a" * 32, "operation": "note", "note": "中文笔记"})
        margins.change(book, {"id": "b" * 32, "operation": "save", "source": self.context})
        margins.change(book, {"id": "c" * 32, "operation": "save", "source": {**source, "quote": "Deleted"}})
        margins.change(book, {"id": "c" * 32, "operation": "remove"})
        with patch("book_import.path_for", return_value=original):
            result = margins.export(book, {}, "pdf")
        path = self.root / "cache/exports" / result["download"].split("/")[-1]
        document = PdfReader(path)
        self.assertEqual(original.read_bytes(), before)
        self.assertEqual(len(document.pages), 4)
        self.assertEqual(document.outline[0].title, "Original chapter")
        self.assertEqual(document.pages[0]["/Annots"][0].get_object()["/Contents"], "Existing note")
        for index, page in enumerate(document.pages):
            self.assertEqual(list(page.cropbox), [40, 100, 560, 700])
            self.assertEqual(page.rotation, index * 90)
            annotations = [ref.get_object() for ref in page["/Annots"]]
            mark = next(a for a in annotations if a["/Subtype"] == "/Highlight")
            self.assertEqual(mark["/Contents"], "Original $x^2$\n\n笔记\n中文笔记")
            self.assertEqual(len(mark["/QuadPoints"]), 8)
            expected = {0: (144, 580), 1: (144, 220), 2: (456, 220), 3: (456, 580)}[index]
            self.assertAlmostEqual(float(mark["/QuadPoints"][0]), expected[0])
            self.assertAlmostEqual(float(mark["/QuadPoints"][1]), expected[1])
            self.assertFalse(any(a.get("/Contents") == "Deleted" for a in annotations))
        notes = [ref.get_object() for ref in document.pages[1]["/Annots"] if ref.get_object()["/Subtype"] == "/Text"]
        self.assertEqual(notes[0]["/Contents"], self.context["quote"])
        self.assertNotIn("/QuadPoints", notes[0])
        import pypdfium2 as pdfium
        with pdfium.PdfDocument(path) as rendered:
            for index in range(4):
                page = rendered[index]
                image = page.render(scale=1, draw_annots=True).to_pil().convert("RGB")
                pixels = image.load()
                marked = [(x, y) for y in range(image.height) for x in range(image.width) if pixels[x, y][1] > pixels[x, y][0] + 3 and pixels[x, y][1] > pixels[x, y][2] + 2]
                self.assertTrue(marked)
                self.assertAlmostEqual(min(x for x, y in marked) / image.width, .2, delta=.012)
                self.assertAlmostEqual(max(x for x, y in marked) / image.width, .6, delta=.012)
                self.assertAlmostEqual(min(y for x, y in marked) / image.height, .2, delta=.012)
                self.assertAlmostEqual(max(y for x, y in marked) / image.height, .24, delta=.012)
                page.close()
        with patch("book_import.path_for", return_value=original), patch.object(margins, "MAX_EXPORT", len(before) + 1):
            with self.assertRaisesRegex(ValueError, "超过"):
                margins.export(book, {}, "pdf")
        self.assertEqual(list(path.parent.glob("*.part")), [])

    def test_saved_pdf_regions_validate_page_range_and_finite_geometry(self):
        for rects in ([{"page": 3, "bbox": [0, 0, 1, 1]}], [{"page": True, "bbox": [0, 0, 1, 1]}], [{"page": 2, "bbox": [0, float("nan"), 1, 1]}], [{"page": 2, "bbox": [.8, 0, .2, 1]}], [{"page": 2, "bbox": [-.1, 0, .2, 1]}]):
            with self.assertRaises(ValueError):
                margins.change(self.book, {"id": "f" * 32, "operation": "save", "source": {**self.context, "rects": rects}})

    def test_original_image_is_portable_in_json_and_markdown_and_has_no_credentials(self):
        with Image.new('RGB',(40,20),'white') as image:
            buffer=io.BytesIO();image.save(buffer,format='PNG')
        source={**self.context,"image":"data:image/png;base64,"+base64.b64encode(buffer.getvalue()).decode()}
        margins.change(self.book,{"id":"a"*32,"operation":"save","source":source})
        with patch('translation.records',return_value={"items":[]}),patch('ai_tutor.records',return_value={"conversations":[]}):
            exported=margins.export(self.book,{},'json')
            data=json.loads((self.root/'cache/exports'/exported['download'].split('/')[-1]).read_text())
            self.assertTrue(data['excerpts'][0]['source']['image'].startswith('data:image/png;base64,'))
            self.assertNotIn('settings',data)
            exported=margins.export(self.book,{},'markdown')
            with zipfile.ZipFile(self.root/'cache/exports'/exported['download'].split('/')[-1]) as archive:
                self.assertIn('页边.md',archive.namelist())
                self.assertEqual(len([name for name in archive.namelist() if name.startswith('images/')]),1)
        margins.validate(self.book,self.root/'books')

    def test_related_saves_preserve_source_and_complete_conversation(self):
        messages = [{"role": "user", "content": "Why does this hold?"},
                    {"role": "assistant", "content": "Use the definition.", "status": "generating",
                     "references": [{"citation": "[1] Definition", "text": "The condition."}]}]
        translated = {"id": "translated", "source": self.context, "text": "Edited $x$", "translation": "译文"}
        payload = {"id": "a" * 32, "operation": "save",
                   "source": {**self.context, "quote": "Client text"}, "related": {"type": "ai", "id": "question"}}
        with patch("ai_tutor.conversation", return_value={"source": self.context, "messages": messages}):
            with self.assertRaisesRegex(ValueError, "结束"):
                margins.change(self.book, payload)
            self.assertEqual(margins.listing(self.book), [])
            messages[-1]["status"] = "ready"
            snapshot = margins.change(self.book, payload)
        for value in ("Why does this hold?", "Use the definition.", "The condition."):
            self.assertIn(value, snapshot["answer"])
        self.assertEqual(snapshot["source"]["quote"], self.context["quote"])
        with patch("translation.records", return_value={"items": [translated]}):
            saved = margins.change(self.book, {**payload, "id": "b" * 32, "related": {"type": "translation", "id": translated["id"]}})
        self.assertEqual(saved["source"]["quote"], self.context["quote"])
        self.assertEqual(saved["source"]["position"], self.context["position"])
        self.assertEqual(saved["translationInput"], translated["text"])

    def test_all_record_types_export_multiple_images_and_reopen_links(self):
        from urllib.parse import parse_qs, urlsplit
        urls = []
        for color in ("white", "black"):
            with Image.new("RGB", (40, 20), color) as image:
                body = io.BytesIO()
                image.save(body, format="PNG")
            urls.append(book_images.save_image(self.book, "data:image/png;base64," + base64.b64encode(body.getvalue()).decode()))
        book = {**self.book, "sourceHash": "d" * 64}
        source = {**self.context, "transferImages": [{"url": url, "raw": ""} for url in urls], "citation": "Original"}
        translated = {"id": "translated", "source": source, "text": self.context["quote"], "translation": "中文译文"}
        conversation = {"id": "question", "book": book["id"], "source": source, "messages": [
            {"role": "user", "content": "A test question"}, {"role": "assistant", "content": "A test answer"}]}
        state = {"bookmarks": [{"book": book["id"], "label": "First page", "position": {"index": 1}}]}
        with patch("translation.records", return_value={"items": [translated]}), patch("ai_tutor.records", return_value={"conversations": [conversation]}):
            exported = margins.export(book, state, "json")
            result = load(self.root / "cache" / "exports" / exported["download"].split("/")[-1], {})
            for key in ("translations", "conversations"):
                self.assertEqual(len(result[key][0]["source"]["transferImages"]), 2)
                self.assertTrue(all(image["url"].startswith("data:image/png;base64,") for image in result[key][0]["source"]["transferImages"]))
            mark_url = urlsplit(result["bookmarks"][0]["sourceLink"])
            self.assertEqual((mark_url.scheme, mark_url.netloc), ("yejian", "source"))
            self.assertEqual(parse_qs(mark_url.query)["sha256"], ["d" * 64])
            exported = margins.export(book, state, "markdown")
            with zipfile.ZipFile(self.root / "cache" / "exports" / exported["download"].split("/")[-1]) as archive:
                markdown = archive.read("页边.md").decode()
                self.assertIn("A test question", markdown)
                self.assertIn("中文译文", markdown)
                self.assertIn("First page", markdown)
                self.assertEqual(len([name for name in archive.namelist() if name.startswith("images/")]), 2)
                self.assertEqual(markdown.count("![原图]"), 4)
