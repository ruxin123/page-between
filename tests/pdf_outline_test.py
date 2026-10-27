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


class PdfOutline(unittest.TestCase):
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
