import copy
import tempfile
import unittest
from pathlib import Path
import library_folders as folders
from storage import load, save


class Folders(unittest.TestCase):
    def test_move_remove_and_restart_preserve_books(self):
        collection = {"books": [{"id":"one"}, {"id":"two", "deletedAt":1}], "jobs":[]}
        originals = copy.deepcopy(collection["books"])
        first = folders.change(collection, {"operation":"create", "name":"数学"})[0]["id"]
        second = folders.change(collection, {"operation":"create", "name":"小说"})[1]["id"]
        folders.change(collection, {"operation":"assign", "id":first, "book":"one"})
        folders.change(collection, {"operation":"assign", "id":second, "book":"one"})
        self.assertEqual(collection["folders"][0]["books"], [])
        folders.change(collection, {"operation":"rename", "id":second, "name":"休闲"})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"library.json"; save(path, collection)
            collection = load(path, {})
        folders.validate(collection["folders"], {"one", "two"})
        folders.change(collection, {"operation":"remove", "id":second})
        self.assertEqual(collection["books"], originals)
        self.assertEqual(collection["folders"][0]["books"], [])

    def test_invalid_operations_do_not_change_membership(self):
        collection = {"books":[{"id":"one"}], "folders":[{"id":"a", "name":"Study", "books":["one"]}]}
        for payload in [{"operation":"create", "name":"study"}, {"operation":"rename", "id":"a", "name":"\n"}, {"operation":"assign", "id":"missing", "book":"one"}, {"operation":"assign", "id":"a", "book":"missing"}]:
            before = copy.deepcopy(collection)
            with self.assertRaises(ValueError): folders.change(collection, payload)
            self.assertEqual(collection, before)
        for members in [["missing"], ["one", "one"]]:
            with self.assertRaises(ValueError): folders.validate([{"id":"a", "name":"Study", "books":members}], {"one"})
