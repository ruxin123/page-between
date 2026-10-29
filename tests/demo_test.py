import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import book_import
from scripts import create_demo as demo
from storage import load, save
from scripts.create_demo import make_epub, make_pdf, make_scan
from scripts.check_publication import findings
from pypdf import PdfReader


class ReviewMaterial(unittest.TestCase):
    def test_old_owned_review_examples_gain_objects_without_replacing_reading_records(
        self,
    ):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with (
                patch.object(demo, "DATA", root),
                patch.object(demo, "DEMO", True),
                patch.object(book_import, "BOOK_ROOT", root / "books"),
            ):
                demo.prepare()
                collection = load(root / "library.json", {})
                for book in collection["books"]:
                    if book["id"] in {"demo-c", "demo-e"}:
                        for field in (
                            "enrichmentUrl",
                            "enhancedPages",
                            "demoEnhancement",
                        ):
                            book.pop(field, None)
                        book["title"] = "用户调整的示例名称"
                save(root / "library.json", collection)
                state = (root / "state.json").read_bytes()
                originals = {
                    p: p.read_bytes() for p in (root / "books").glob("*/original.*")
                }
                self.assertEqual(demo.upgrade(), 2)
                self.assertEqual(demo.upgrade(), 0)
                self.assertEqual((root / "state.json").read_bytes(), state)
                self.assertTrue(
                    all(path.read_bytes() == body for path, body in originals.items())
                )
                books = load(root / "library.json", {})["books"]
                self.assertTrue(
                    all(
                        book["demoEnhancement"]
                        and book["title"] == "用户调整的示例名称"
                        for book in books
                        if book["id"] in {"demo-c", "demo-e"}
                    )
                )
                collection = load(root / "library.json", {})
                for book in collection["books"]:
                    if book["id"] in {"demo-c", "demo-e"}:
                        book.pop("enrichmentUrl")
                        if book["id"] == "demo-c":
                            book["sourceHash"] = "0" * 64
                collection["jobs"] = [
                    {"book": "demo-e", "kind": "mineru", "status": "paused"}
                ]
                save(root / "library.json", collection)
                self.assertEqual(demo.upgrade(), 0)

    def test_generated_epub_keeps_images_math_and_non_linear_notes(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder:
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
        self.assertFalse(findings("ios/PageBetween/Assets.xcassets/AppIcon.appiconset/AppIcon.png", b"\x89PNG"))
        self.assertTrue(findings("ios/private-book.png", b"\x89PNG"))
        self.assertFalse(findings("core.mjs", b'export const title="Example";'))


if __name__ == "__main__":
    unittest.main()
