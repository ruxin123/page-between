import json
import os
import tempfile
import unittest
from pathlib import Path

from cache_policy import discard_export, prune_exports, prune_mineru_result, clear_incomplete_exports


class CachePolicy(unittest.TestCase):
    def test_exports_expire_and_arbitrary_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            exports = root / "exports"
            exports.mkdir()
            for i in range(5):
                path = exports / (f"{i:032x}.epub")
                path.write_text("temporary export")
                os.utime(path, (5000 + i, 5000 + i))
            original = root / "original.epub"
            original.write_text("book")
            prune_exports(root, now=6000)
            self.assertEqual(len(list(exports.glob("*.epub"))), 3)
            with self.assertRaises(ValueError):
                discard_export(root, "../original.epub")
            self.assertEqual(original.read_text(), "book")
            discard_export(root, f"{4:032x}.epub")
            prune_exports(root, now=10000)
            self.assertEqual(list(exports.iterdir()), [])

    def test_export_budget_keeps_only_the_latest_large_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            exports = root / "exports"
            exports.mkdir()
            for i in range(3):
                path = exports / (f"{i:032x}.pbbackup")
                with path.open("wb") as stream:
                    stream.truncate(300 * 1024**2)
                os.utime(path, (5000 + i, 5000 + i))
            prune_exports(root, now=6000)
            self.assertEqual([path.name for path in exports.iterdir()], [f"{2:032x}.pbbackup"])

    def test_cleanup_does_not_follow_an_export_directory_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = root / "manual-backup"
            original.mkdir()
            name = "a" * 32 + ".epub"
            (original / name).write_text("keep")
            (root / "exports").symlink_to(original, target_is_directory=True)
            prune_exports(root, now=10**12)
            with self.assertRaises(ValueError):
                discard_export(root, name)
            self.assertEqual((original / name).read_text(), "keep")

    def test_cloud_cleanup_requires_published_results_and_finished_checkpoint(self):
        with tempfile.TemporaryDirectory() as temporary:
            book = Path(temporary)
            folder = book / "mineru" / "batch"
            folder.mkdir(parents=True)
            raw = folder / "result.zip"
            raw.write_text("raw")
            manifest = folder / "job.json"
            manifest.write_text(json.dumps({"state": "running"}))
            canonical = book / "mineru-enhancement.json"
            canonical.write_text('{"1":{"blocks":[]}}')
            prune_mineru_result(folder)
            self.assertTrue(raw.exists())
            manifest.write_text(json.dumps({"state": "done"}))
            canonical.write_text("broken JSON")
            with self.assertRaises(ValueError):
                prune_mineru_result(folder)
            self.assertTrue(raw.exists())
            canonical.write_text('{"image":"/data/books/book/mineru/batch/figure.png"}')
            prune_mineru_result(folder)
            self.assertTrue(raw.exists())
            canonical.write_text('{"1":{"blocks":[]}}')
            prune_mineru_result(folder)
            self.assertFalse(raw.exists())
            self.assertTrue(manifest.exists())
            self.assertTrue(canonical.exists())

    def test_startup_removes_only_unpublished_export_work(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            exports = root / "exports"
            exports.mkdir()
            partial = exports / ("a" * 32 + ".part")
            partial.write_text("unfinished")
            work = exports / ".epub-original-test"
            work.mkdir()
            completed = exports / ("b" * 32 + ".epub")
            completed.write_text("ready")
            clear_incomplete_exports(root)
            self.assertFalse(partial.exists())
            self.assertFalse(work.exists())
            self.assertTrue(completed.exists())
