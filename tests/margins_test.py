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
