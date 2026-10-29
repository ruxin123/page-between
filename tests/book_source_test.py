import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import book_source as source


class BookSource(unittest.TestCase):
    def test_download_import_deduplicates_and_removes_temporary_files(self):
        import server
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); collection = {"books":[], "jobs":[]}
            def acquire(ref, destination):
                destination.mkdir(parents=True)
                path = destination/"original.txt"; path.write_text("original fixture")
                return path
            def imported(path, enabled):
                import hashlib
                return {"id":"original", "type":"txt", "parseEnabled":False, "sourceHash":hashlib.sha256(path.read_bytes()).hexdigest()}
            with patch.object(source,"DOWNLOADS", root/"downloads"), patch.object(source,"acquire",side_effect=acquire), patch.object(server,"library",return_value=collection), patch.object(server,"DATA",root), patch.object(server,"save"), patch.object(server,"import_book",side_effect=imported) as importer, patch.object(server,"SOURCE_TASKS",{}):
                for duplicate in (False, True):
                    task = server.source_download({"ref":"chosen-edition", "parse":False})
                    deadline = time.monotonic()+3
                    while time.monotonic()<deadline:
                        task = server.SOURCE_TASKS[task["id"]]
                        if task["status"] in {"ready","error"} and not (source.DOWNLOADS/task["id"]).exists(): break
                        time.sleep(.01)
                    self.assertEqual(task["status"], "ready", task)
                    self.assertEqual(task["duplicate"], duplicate)
                    self.assertFalse((source.DOWNLOADS/task["id"]).exists())
                self.assertEqual(importer.call_count, 1)
                self.assertEqual(len(collection["books"]), 1)

    def test_search_uses_zlibrary_and_cursor_is_exclusive(self):
        with patch.object(source.CLIENT, "call", return_value={"rows":[]}) as call:
            source.call({"operation":"search", "query":"original", "format":"epub"})
            self.assertEqual(call.call_args.args, ("search", {"query":"original", "sources":["zlibrary"], "limit":20, "formats":["epub"]}))
            source.call({"operation":"search", "cursor":"next", "query":"ignored"})
            self.assertEqual(call.call_args.args, ("search", {"cursor":"next"}))
            with self.assertRaises(ValueError):
                source.call({"operation":"search", "query":"original", "format":"exe"})

    def test_password_stays_in_keychain_and_account_change_requires_password(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(source, "SETTINGS", Path(folder)/"settings.json"), patch.object(source.service_settings, "keychain") as keychain, patch.object(source.CLIENT, "close"):
            result = source.configure({"email":"reader@example.invalid", "password":"private-value"})
            self.assertTrue(result["hasPassword"])
            self.assertNotIn("private-value", source.SETTINGS.read_text())
            source.configure({"email":"reader@example.invalid", "password":""})
            self.assertEqual(keychain.call_count, 1)
            with self.assertRaises(ValueError):
                source.configure({"email":"other@example.invalid", "password":""})
            with self.assertRaises(ValueError):
                source.configure({"email":"", "password":"private-value"})

    def test_acquire_refuses_outside_path_and_keeps_download_inside_owned_folder(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            outside = base/"outside.txt"; outside.write_text("outside")
            with patch.object(source.CLIENT, "call", return_value={"path":str(outside)}):
                with self.assertRaises(ValueError): source.acquire("row-ref", base/"download")
            def download(name, args):
                path = Path(args["output_dir"])/"original.txt"; path.write_text("original")
                return {"path":str(path)}
            with patch.object(source.CLIENT, "call", side_effect=download):
                self.assertEqual(source.acquire("row-ref", base/"valid").read_text(), "original")

    def test_stdio_initialization_and_multiple_calls_share_one_process(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root/"dist").mkdir(); (root/"dist/index.js").touch(); (root/"node").touch()
            script = root/"fake.py"
            script.write_text('''import json,sys
for line in sys.stdin:
 value=json.loads(line)
 if "id" not in value: continue
 method=value["method"]
 if method=="initialize": result={"protocolVersion":"2025-11-25"}
 elif method=="tools/list": result={"tools":[{"name":name} for name in ["search","get_book","download","get_limits"]]}
 else: result={"structuredContent":{"ref":"same-process", "argument":value["params"]["arguments"]}}
 print(json.dumps({"jsonrpc":"2.0","id":value["id"],"result":result}),flush=True)
''')
            original = source.subprocess.Popen
            def start(command, **kwargs): return original([sys.executable, str(script)], **kwargs)
            client = source.MCPClient()
            with patch.object(source,"RUNTIME",root), patch.object(source,"SETTINGS",root/"settings.json"), patch.object(source,"DOWNLOADS",root/"downloads"), patch.object(source.subprocess,"Popen",side_effect=start) as spawn:
                try:
                    self.assertEqual(client.call("search", {"query":"book"})["ref"], "same-process")
                    self.assertEqual(client.call("get_book", {"ref":"same-process"})["argument"], {"ref":"same-process"})
                    self.assertEqual(spawn.call_count, 1)
                    (root/"settings.json").write_text(json.dumps({"email":"updated@example.invalid"}))
                    self.assertEqual(client.call("get_limits", {})["ref"], "same-process")
                    self.assertEqual(spawn.call_count, 2)
                finally: client.close()


if __name__ == "__main__": unittest.main()
