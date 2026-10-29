import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server
from storage import save, load


class Removal(unittest.TestCase):
    def test_remove_and_restore_preserve_files_reading_records_and_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            book = {"id":"original", "title":"Original", "type":"txt", "parseEnabled":True}
            folder = root/"books/original"; folder.mkdir(parents=True)
            original = folder/"original.txt"; original.write_bytes(b"Original fixture content")
            save(folder/"book.json", book)
            save(root/"library.json", {"books":[book], "jobs":[]})
            records = {"state.json":{"positions":{"original":{"index":1}}}, "ai-conversations.json":{"conversations":[{"book":"original"}]}}
            for name, data in records.items(): save(root/name,data)
            with patch.object(server,"DATA",root), patch.object(server,"BOOK_ROOT",root/"books"), patch.object(server,"RUNNING",set()), patch.object(server.ai_tutor,"CANCELLATIONS",{}), patch.object(server.translation,"JOBS",{}):
                removed = server.set_book_deleted("original",True)
                self.assertTrue(removed["deletedAt"])
                self.assertIsNone(server.book_for("original"))
                self.assertEqual(original.read_bytes(), b"Original fixture content")
                for name, data in records.items(): self.assertEqual(load(root/name,{}),data)
                restored = server.set_book_deleted("original",False)
                self.assertEqual(restored["id"],book["id"])
                self.assertFalse(restored["deletedAt"])
                self.assertIsNotNone(server.book_for("original"))
                self.assertEqual(len(server.library()["books"]),1)

    def test_active_document_job_is_not_removed(self):
        with patch.object(server,"library",return_value={"books":[{"id":"original"}]}), patch.object(server,"RUNNING",{"original"}), patch.object(server,"update_book") as update:
            with self.assertRaises(ValueError): server.set_book_deleted("original",True)
            update.assert_not_called()

    def test_unknown_identifier_does_not_change_storage(self):
        with patch.object(server,"library",return_value={"books":[]}), patch.object(server,"update_book") as update:
            with self.assertRaises(ValueError): server.set_book_deleted("../original",True)
            update.assert_not_called()
