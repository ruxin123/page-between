import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import book_import
from scripts.create_demo import make_epub, make_pdf, make_scan
from scripts.check_publication import findings
from pypdf import PdfReader


class ReviewMaterial(unittest.TestCase):
    def test_generated_epub_keeps_images_math_and_non_linear_notes(self):
        with tempfile.TemporaryDirectory(
            dir=book_import.ROOT / "tmp", ignore_cleanup_errors=True
        ) as folder:
            root = Path(folder)
            source = root / "sample.epub"
            make_epub(source)
            with patch.object(book_import, "BOOK_ROOT", root / "books"):
                book = book_import.import_book(source)
                self.assertEqual(len(book["chapters"]), 7)
                self.assertEqual(len(book["toc"]), 6)
                content = root / "books" / book["id"] / "content/OPS"
                self.assertTrue((content / "figure.svg").exists())
                self.assertTrue((content / "notes.xhtml").exists())
                self.assertIn("<math", (content / "chapter-2.xhtml").read_text())
                with zipfile.ZipFile(source) as archive:
                    self.assertEqual(archive.namelist()[0], "mimetype")

    def test_generated_pdf_and_scan_are_distinct_reading_paths(self):
        with tempfile.TemporaryDirectory() as folder:
            native = Path(folder) / "native.pdf"
            scan = Path(folder) / "scan.pdf"
            make_pdf(native)
            make_scan(native, scan)
            original = PdfReader(native)
            scanned = PdfReader(scan)
            self.assertEqual(len(original.pages), 4)
            self.assertEqual(len(original.outline), 4)
            self.assertIn("Definition 1.1", original.pages[0].extract_text())
            self.assertEqual(len(scanned.pages), 4)
            self.assertFalse(scanned.pages[0].extract_text().strip())

    def test_publication_gate_checks_files_and_content_without_printing_values(self):
        self.assertTrue(findings("data/state.json", b"{}"))
        self.assertTrue(findings(".env", b"EXAMPLE=value"))
        self.assertTrue(findings("qa/screen.png", b"\x89PNG"))
        self.assertTrue(
            findings("README.md", b"private book title", ["private book title"])
        )
        self.assertTrue(findings("script.py", ("ghp_" + "a" * 36).encode()))
        self.assertFalse(findings("docs/screenshots/library.png", b"\x89PNG"))
        self.assertFalse(findings("core.mjs", b'export const title="Example";'))


if __name__ == "__main__":
    unittest.main()
