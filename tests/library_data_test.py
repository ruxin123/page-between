import hashlib
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import book_import
import library_data as data
from storage import load, save


class LibraryRecovery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.library = self.root / "Personal/Library"
        self.library.mkdir(parents=True)
        self.overrides = [
            patch.object(data, "DATA", self.library),
            patch.object(data, "CACHE", self.root / "cache"),
            patch.object(book_import, "BOOK_ROOT", self.library / "books"),
        ]
        for override in self.overrides:
            override.start()
        source = self.root / "sample.txt"
        source.write_text("第一章 起点\n\n定义 1.1 一个函数的每个输入只有一个输出。")
        self.book = book_import.import_book(source, title="Original sample")
        self.snapshot = {
            "library.json": {"books": [self.book], "jobs": []},
            "state.json": {"prefs": {"fontSize": 21}, "positions": {}, "bookmarks": []},
            "ai-conversations.json": {
                "conversations": [
                    {
                        "id": "a" * 32,
                        "book": self.book["id"],
                        "source": {
                            "quote": "一个函数的每个输入只有一个输出。",
                            "context": "",
                            "position": {"index": 1},
                        },
                        "messages": [
                            {"role": "user", "content": "解释"},
                            {
                                "role": "assistant",
                                "content": "**安全的回答**",
                                "html": '<script>bad()</script><img src="https://invalid.example/">',
                                "status": "generating",
                            },
                        ],
                    }
                ]
            },
        }
        for name, value in self.snapshot.items():
            save(self.library / name, value)
        self.services = self.library.parent / "services.json"
        self.services.write_text('{"keyRef":"synthetic-reference-only"}')

    def tearDown(self):
        for override in reversed(self.overrides):
            override.stop()
        self.temp.cleanup()

    def package(self):
        result = data.backup(self.snapshot)
        return self.root / "cache/exports" / result["id"]

    def change_current(self):
        collection = load(self.library / "library.json", {})
        collection["books"][0]["title"] = "Current library"
        save(self.library / "library.json", collection)
        save(
            self.library / "books" / self.book["id"] / "book.json",
            collection["books"][0],
        )
        save(self.library / "state.json", {"prefs": {"fontSize": 40}})

    def test_verified_backup_requires_confirmation_and_can_return_to_previous_library(
        self,
    ):
        package = self.package()
        with zipfile.ZipFile(package) as archive:
            self.assertFalse(
                any(
                    "services" in name or "cache/" in name
                    for name in archive.namelist()
                )
            )
            self.assertEqual(json.loads(archive.read("manifest.json"))["schema"], 1)
        self.change_current()
        before = self.services.read_bytes()
        self.assertEqual(data.prepare_restore(package)["books"], 1)
        data.apply_pending_restore()
        self.assertEqual(
            load(self.library / "library.json", {})["books"][0]["title"],
            "Current library",
        )
        data.approve_restore()
        data.apply_pending_restore()
        self.assertEqual(
            load(self.library / "library.json", {})["books"][0]["title"],
            "Original sample",
        )
        self.assertEqual(load(self.library / "state.json", {})["prefs"]["fontSize"], 21)
        self.assertEqual(self.services.read_bytes(), before)
        message = load(self.library / "ai-conversations.json", {})["conversations"][0][
            "messages"
        ][-1]
        self.assertEqual(message["status"], "error")
        self.assertNotIn("<script", message["html"])
        self.assertNotIn("<img", message["html"])
        self.assertTrue(data.information()["previousAvailable"])
        data.prepare_previous()
        data.approve_restore()
        data.apply_pending_restore()
        self.assertEqual(
            load(self.library / "library.json", {})["books"][0]["title"],
            "Current library",
        )

    def test_checksum_and_path_traversal_fail_without_touching_the_current_library(
        self,
    ):
        package = self.package()
        original = (self.library / "library.json").read_bytes()
        for unsafe in [False, True]:
            altered = self.root / ("unsafe.pbbackup" if unsafe else "corrupt.pbbackup")
            with zipfile.ZipFile(package) as archive:
                entries = {name: archive.read(name) for name in archive.namelist()}
            if unsafe:
                manifest = json.loads(entries["manifest.json"])
                name = "books/../../escape.txt"
                content = b"escape"
                manifest["files"][name] = {
                    "sha256": hashlib.sha256(content).hexdigest(),
                    "size": len(content),
                }
                entries["manifest.json"] = json.dumps(manifest).encode()
                entries["Library/" + name] = content
            else:
                entries["Library/state.json"] = b"{}"
            with zipfile.ZipFile(altered, "w") as archive:
                for name, content in entries.items():
                    archive.writestr(name, content)
            with self.assertRaises(ValueError):
                data.prepare_restore(altered)
            self.assertEqual((self.library / "library.json").read_bytes(), original)
            self.assertFalse(data.record_path("pending-restore").exists())

    def test_restart_completes_after_the_old_directory_was_already_moved(self):
        package = self.package()
        self.change_current()
        data.prepare_restore(package)
        data.approve_restore()
        journal = load(data.record_path("pending-restore"), {})
        self.library.rename(self.library.parent / journal["backup"])
        data.apply_pending_restore()
        self.assertTrue(self.library.is_dir())
        self.assertEqual(
            load(self.library / "library.json", {})["books"][0]["title"],
            "Original sample",
        )
        self.assertFalse(data.record_path("pending-restore").exists())

    def test_failed_activation_rolls_back_and_corrupt_journal_does_not_prevent_startup(
        self,
    ):
        package = self.package()
        self.change_current()
        data.prepare_restore(package)
        data.approve_restore()
        journal = load(data.record_path("pending-restore"), {})
        stage = self.library.parent / journal["stage"]
        original = Path.rename

        def rename(source, target):
            if source == stage:
                raise OSError("injected activation failure")
            return original(source, target)

        with patch.object(Path, "rename", autospec=True, side_effect=rename):
            data.apply_pending_restore()
        self.assertEqual(
            load(self.library / "library.json", {})["books"][0]["title"],
            "Current library",
        )
        self.assertFalse(data.information()["lastRestore"]["restored"])
        data.record_path("pending-restore").write_text("broken json")
        data.apply_pending_restore()
        self.assertTrue(self.library.is_dir())
        self.assertFalse(data.record_path("pending-restore").exists())

    def test_restart_recognizes_an_already_activated_directory(self):
        package = self.package()
        self.change_current()
        data.prepare_restore(package)
        data.approve_restore()
        journal = load(data.record_path("pending-restore"), {})
        self.library.rename(self.library.parent / journal["backup"])
        (self.library.parent / journal["stage"]).rename(self.library)
        data.apply_pending_restore()
        self.assertEqual(
            load(self.library / "library.json", {})["books"][0]["title"],
            "Original sample",
        )
        self.assertTrue(data.information()["lastRestore"]["restored"])
        self.assertFalse(data.record_path("pending-restore").exists())

    def test_cancel_and_cache_cleanup_keep_books_and_service_settings(self):
        package = self.package()
        data.prepare_restore(package)
        data.cancel_restore()
        self.assertFalse(data.record_path("pending-restore").exists())
        for name in ["ocr-v3", "book-index-v1", "exports"]:
            (self.root / "cache" / name).mkdir(exist_ok=True, parents=True)
            (self.root / "cache" / name / "generated").write_text("cache")
        data.queue_cache_cleanup()
        data.apply_cache_cleanup()
        self.assertTrue(
            (self.library / "books" / self.book["id"] / "original.txt").is_file()
        )
        self.assertTrue(self.services.is_file())
        self.assertFalse((self.root / "cache/ocr-v3").exists())

    def test_completed_cloud_cache_is_excluded_but_unfinished_checkpoints_are_retained(
        self,
    ):
        directory = self.library / "books" / self.book["id"]
        save(directory / "mineru-enhancement.json", {"1": {"blocks": []}})
        save(directory / "mineru/done/job.json", {"state": "done"})
        save(
            directory / "mineru/pending/job.json",
            {"chunks": {"0": {"batchId": "synthetic"}}},
        )
        package = self.package()
        with zipfile.ZipFile(package) as archive:
            names = archive.namelist()
            self.assertFalse(any("mineru/done/" in name for name in names))
            self.assertTrue(any("mineru/pending/" in name for name in names))
        data.queue_cache_cleanup()
        data.apply_cache_cleanup()
        self.assertFalse((directory / "mineru/done").exists())
        self.assertTrue((directory / "mineru/pending/job.json").is_file())
        self.assertTrue((directory / "mineru-enhancement.json").is_file())


if __name__ == "__main__":
    unittest.main()
