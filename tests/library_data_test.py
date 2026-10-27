import hashlib
import base64
import io
import shutil
import json
import copy
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import book_import
import book_images
from PIL import Image
import library_data as data
from storage import load, save


class LibraryRecovery(unittest.TestCase):
    def test_saved_selection_text_survives_backup_restore_and_cache_cleanup(self):
        folder = (
            self.library
            / "books"
            / self.book["id"]
            / "selection-text-v1"
            / "diagnostic-fingerprint"
        )
        saved_page = folder / "1.json"
        save(
            saved_page,
            {
                "page": 1,
                "selectionFingerprint": folder.name,
                "lines": [{"text": "Original saved selection"}],
            },
        )
        original = saved_page.read_bytes()
        task = folder.parent.parent / "selection-preparation.json"
        save(task, {"fingerprint": folder.name, "status": "paused", "errors": {}})
        package = self.package()
        saved_page.unlink()
        task.unlink()
        data.prepare_restore(package)
        data.approve_restore()
        data.apply_pending_restore()
        self.assertEqual(saved_page.read_bytes(), original)
        self.assertEqual(load(task, {})["status"], "paused")
        data.queue_cache_cleanup()
        data.apply_cache_cleanup()
        self.assertEqual(saved_page.read_bytes(), original)

    def altered_package(self, mutate):
        package = self.package()
        with zipfile.ZipFile(package) as archive:
            entries = {name: archive.read(name) for name in archive.namelist()}
        collection = json.loads(entries["Library/library.json"])
        state = json.loads(entries["Library/state.json"])
        mutate(collection, state)
        manifest = json.loads(entries["manifest.json"])
        for name, value in (("library.json", collection), ("state.json", state)):
            content = json.dumps(value, ensure_ascii=False).encode()
            entries["Library/" + name] = content
            manifest["files"][name] = {
                "sha256": hashlib.sha256(content).hexdigest(),
                "size": len(content),
            }
        entries["manifest.json"] = json.dumps(manifest).encode()
        target = self.root / "altered.pbbackup"
        with zipfile.ZipFile(target, "w") as archive:
            for name, value in entries.items():
                archive.writestr(name, value)
        return target

    def test_malformed_navigation_and_bookmark_metadata_are_rejected_before_activation(
        self,
    ):
        original = (self.library / "library.json").read_bytes()

        def toc_index(collection, state):
            collection["books"][0]["toc"][0]["index"] = '1" onclick="bad()'

        def toc_children(collection, state):
            collection["books"][0]["toc"][0]["children"] = {}

        def toc_pdf_y(collection, state):
            collection["books"][0]["toc"][0]["pdfY"] = "invalid"

        def chapter_title(collection, state):
            collection["books"][0]["chapters"][0]["title"] = {"bad": True}

        def bookmark(collection, state):
            state["bookmarks"] = [
                {
                    "id": 'bad" onclick="bad()',
                    "book": self.book["id"],
                    "position": {"index": 1},
                }
            ]

        def position(collection, state):
            state["positions"] = {self.book["id"]: {"index": "1"}}

        def job(collection, state):
            collection["jobs"] = [
                {"book": self.book["id"], "kind": "mineru", "pages": "not a page list"}
            ]

        for mutate in (toc_index, toc_children, toc_pdf_y, chapter_title, bookmark, position, job):
            with self.subTest(case=mutate.__name__):
                with self.assertRaises(ValueError):
                    data.prepare_restore(self.altered_package(mutate))
                self.assertEqual((self.library / "library.json").read_bytes(), original)
                self.assertFalse(data.record_path("pending-restore").exists())

    def test_printed_page_labels_remain_plain_text_and_resources_belong_to_book(self):
        label = '<img src="missing" onerror="bad()">'

        def plain_label(collection, state):
            collection["books"][0]["toc"][0]["printed"] = label
            state["bookmarks"] = [
                {
                    "id": "legacy-mark_1",
                    "book": self.book["id"],
                    "label": "Old bookmark",
                    "position": {"index": 1, "anchor": None},
                }
            ]

        data.prepare_restore(self.altered_package(plain_label))
        pending = load(data.record_path("pending-restore"), {})
        staged = self.library.parent / pending["stage"]
        self.assertEqual(
            load(staged / "library.json", {})["books"][0]["toc"][0]["printed"], label
        )
        data.cancel_restore()
        second = copy.deepcopy(self.book)

        def relocate(value):
            if isinstance(value, dict):
                return {key: relocate(item) for key, item in value.items()}
            if isinstance(value, list):
                return [relocate(item) for item in value]
            if isinstance(value, str):
                return value.replace("/" + self.book["id"] + "/", "/other-book/")
            return value

        second = relocate(second)
        second["id"] = "other-book"
        directory = self.library / "books/other-book"
        shutil.copytree(self.library / "books" / self.book["id"], directory)
        self.snapshot["library.json"]["books"].append(second)
        save(self.library / "library.json", self.snapshot["library.json"])

        def cross_book(collection, state):
            collection["books"][0]["originalUrl"] = self.book["originalUrl"].replace(
                "/" + self.book["id"] + "/", "/other-book/"
            )

        with self.assertRaises(ValueError):
            data.prepare_restore(self.altered_package(cross_book))

    def test_stale_backup_snapshot_cannot_publish_a_missing_text_version(self):
        old = book_import.path_for(self.book["contentUrl"])
        new = old.with_name("text-newer.json")
        new.write_bytes(old.read_bytes())
        current = copy.deepcopy(self.snapshot["library.json"])
        current["books"][0]["contentUrl"] = book_import.url_for(new)
        save(self.library / "library.json", current)
        old.unlink()
        with self.assertRaisesRegex(ValueError, "内容已更新"):
            self.package()
        self.assertEqual(load(self.library / "library.json", {}), current)
        self.assertEqual(list((self.root / "cache/exports").glob("*.pbbackup")), [])

    def test_image_conversation_restores_from_staged_resources_without_active_original(
        self,
    ):
        output = io.BytesIO()
        Image.new("RGB", (48, 32), "white").save(output, format="PNG")
        url = book_images.save_image(
            self.book,
            "data:image/png;base64," + base64.b64encode(output.getvalue()).decode(),
        )
        source = self.snapshot["ai-conversations.json"]["conversations"][0]["source"]
        source["image"] = url
        self.snapshot["ai-conversations.json"]["conversations"][0]["messages"][0][
            "imageAttached"
        ] = True
        save(
            self.library / "ai-conversations.json",
            self.snapshot["ai-conversations.json"],
        )
        original = book_import.path_for(url)
        body = original.read_bytes()
        package = self.package()
        original.unlink()
        data.prepare_restore(package)
        data.approve_restore()
        data.apply_pending_restore()
        restored = load(self.library / "ai-conversations.json", {})["conversations"][0]
        self.assertEqual(restored["source"]["image"], url)
        self.assertTrue(restored["messages"][0]["imageAttached"])
        self.assertEqual(book_images.stored_image(self.book, url)[0], body)

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
