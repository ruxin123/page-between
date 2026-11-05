import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
import library_transfer as transfer

class TransferTest(unittest.TestCase):
    def test_roundtrip_and_tamper(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); original = root / 'sample.txt'; original.write_text('Original reading content.\n')
            position = dict(index=2, progress=.4, chapterFraction=.3, pdfY=0)
            record = dict(title='原创读本', author='原创作者', position=position, bookmarks=[dict(title='第二章', position=position)])
            package = root/'sample.pbtransfer'; transfer.write(package, [(record, original)])
            result = transfer.read(package, root)
            self.assertEqual(result[0]['position'], position)
            self.assertEqual(result[0]['source'].read_bytes(), original.read_bytes())
            self.assertNotIn('settings', result[0])
            with zipfile.ZipFile(package) as archive:
                values = {name: archive.read(name) for name in archive.namelist()}
            values[next(name for name in values if name.startswith('books/'))] = b'damaged'
            with zipfile.ZipFile(package, 'w') as archive:
                for name, data in values.items(): archive.writestr(name, data)
            with self.assertRaises(ValueError): transfer.read(package, root)
    def test_rejects_paths_extras_and_invalid_progress(self):
        for value in [dict(index=True),dict(index=-1),dict(progress=float('nan')),dict(progress=1.1)]:
            with self.assertRaises(ValueError): transfer.position(value)
        with tempfile.TemporaryDirectory() as folder:
            target=Path(folder)/'bad.pbtransfer'
            for path in ['../outside', '/absolute', 'books/not-a-hash.txt']:
                with zipfile.ZipFile(target,'w') as archive:
                    archive.writestr('manifest.json',json.dumps(dict(schema=1,kind='page-between-transfer',books=[dict(file=path)])))
                    archive.writestr(path,b'bad')
                with self.assertRaises(ValueError): transfer.read(target, folder)

if __name__ == '__main__': unittest.main()
