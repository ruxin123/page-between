import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pypdf import PdfWriter
from pypdf.generic import Fit, RectangleObject

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import book_import
import server
from storage import load, save
from pdf_enhancement import page_offset_patch


class PdfOutline(unittest.TestCase):
    def test_manual_offset_reset_restores_automatic_mapping_and_preserves_source_positions(self):
        book = {"pages": 100, "automaticPageOffset": 12, "pageOffset": 12,
                "toc": [{"title": "Original", "printed": 3, "index": 15, "pdfY": .2,
                         "children": [{"title": "Native destination", "index": 17, "pdfY": .6}]}]}
        manual = page_offset_patch(book, 20)
        self.assertEqual(manual["toc"][0]["index"], 23)
        self.assertEqual(book["toc"][0]["index"], 15)
        restored = page_offset_patch({**book, **manual}, None)
        self.assertEqual(restored["pageOffsetMode"], "auto")
        self.assertEqual(restored["pageOffset"], 12)
        self.assertEqual(restored["toc"], book["toc"])
        for invalid in [True, "3", 3.5, 101]:
            with self.assertRaises(ValueError): page_offset_patch(book, invalid)

    def test_legacy_auto_reset_recovers_ocr_mapping_without_replacing_toc(self):
        book = {"pages": 100, "pageOffset": 20, "tocSource": "ocr-contents", "tocPages": [3, 5],
                "toc": [{"title": "User title", "printed": 3, "index": 23, "pdfY": .4}]}
        with patch("pdf_enhancement.automatic_page_offset", return_value=(12, 1)) as recover:
            restored = page_offset_patch(book, None)
        recover.assert_called_once_with(book, 5)
        self.assertEqual(restored["automaticPageOffset"], 12)
        self.assertEqual(restored["toc"][0], {"title": "User title", "printed": 3, "index": 15, "pdfY": .4})

    def test_destinations_preserve_same_page_positions_crop_and_rotation(self):
        with tempfile.TemporaryDirectory() as folder:
            writer = PdfWriter()
            for rotation in (0, 90, 180, 270):
                page = writer.add_blank_page(600, 800)
                page.cropbox = RectangleObject([40, 100, 560, 700])
                page.rotate(rotation)
                writer.add_outline_item(
                    "Original rotation " + str(rotation),
                    len(writer.pages) - 1,
                    fit=Fit.xyz(left=170, top=550),
                )
            writer.add_outline_item(
                "Original lower section", 0, fit=Fit.fit_horizontally(top=160)
            )
            writer.add_outline_item("Original whole page", 0, fit=Fit.fit())
            writer.add_outline_item("Original unspecified position", 0, fit=Fit.xyz())
            source = Path(folder) / "original.pdf"
            writer.write(source)
            with patch.object(book_import, "url_for", return_value="/original.pdf"):
                metadata = book_import.pdf_metadata(source)
            entries = list(book_import.flatten_toc(metadata["toc"]))
            self.assertEqual([e["index"] for e in entries], [1, 2, 3, 4, 1, 1, 1])
            for entry, expected in zip(entries, [.25, .25, .75, .75, .9, 0, 0]):
                self.assertAlmostEqual(entry["pdfY"], expected)
            self.assertEqual(metadata["pdfOutlineVersion"], 1)

    def test_existing_outline_upgrade_only_changes_navigation_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            save(root / "library.json", {
                "books": [
                    {
                        "id": "original", "type": "pdf", "url": "/original.pdf",
                        "tocSource": "pdf-outline",
                        "toc": [{"title": "Legacy", "index": 1}],
                        "title": "Keep title", "parseEnabled": False,
                    },
                    {"id": "scan", "type": "pdf", "tocSource": "ocr-contents", "toc": []},
                ],
                "jobs": [],
            })
            source = root / "original.pdf"
            writer = PdfWriter()
            writer.add_blank_page(600, 800)
            writer.add_outline_item("Original section", 0, fit=Fit.xyz(left=80, top=200))
            writer.write(source)
            original_bytes = source.read_bytes()
            with (
                patch.object(server, "DATA", root),
                patch.object(server, "BOOK_ROOT", root / "books"),
                patch.object(server, "path_for", return_value=source),
                patch.object(book_import, "url_for", return_value="/original.pdf"),
            ):
                server.upgrade_pdf_outlines()
                result = load(root / "library.json", {})
                self.assertEqual(result["books"][0]["toc"][0]["pdfY"], .75)
                self.assertEqual(result["books"][0]["title"], "Keep title")
                self.assertFalse(result["books"][0]["parseEnabled"])
                self.assertEqual(result["books"][1]["toc"], [])
                with patch.object(
                    server, "pdf_metadata", side_effect=AssertionError("Must not reparse")
                ):
                    server.upgrade_pdf_outlines()
                self.assertEqual(load(root / "library.json", {}), result)
                self.assertEqual(source.read_bytes(), original_bytes)


if __name__ == "__main__":
    unittest.main()
