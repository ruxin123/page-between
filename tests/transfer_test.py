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

    def test_record_merge_keeps_local_notes_and_appearance(self):
        import io
        from unittest.mock import patch
        from PIL import Image
        import ai_tutor
        import book_import
        import book_margins
        import translation
        import transfer_records as records
        from storage import save
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); books = root/'books'; directory = books/'sample'; directory.mkdir(parents=True)
            book = dict(id='sample', title='原创数学', type='pdf', pages=3, toc=[])
            image = io.BytesIO(); Image.new('RGB', (4, 4), (255, 255, 255)).save(image, format='PNG'); body = image.getvalue()
            name = hashlib.sha256(body).hexdigest() + '.png'; original = root/name; original.write_bytes(body)
            image_path = 'images/' + name
            position = dict(index=2, endIndex=3, pdfY=.25)
            box = dict(left=.1, top=.2, right=.5, bottom=.3)
            source = dict(quote='$x^2$', markdown='$$x^2$$', position=position, kind='equation', chapter='PDF 第 2 页', images=[dict(file=image_path,raw='$x^2$')], objects=[dict(page=2,box=box,type='equation',text='$x^2$')], rects=[dict(page=2,box=box),dict(page=3,box=box)])
            record = dict(schema=1, excerpts=[dict(id='1'*32, source=source, createdAt=1794000000, note='Imported note')], translations=[], conversations=[dict(id='2'*32, source=source, createdAt=1794000000, updatedAt=1794000000, messages=[dict(id='3'*32, role='user', content='Explain'),dict(id='4'*32, role='assistant', content='Original result [3].', references=[dict(number=3,text='Reference',citation='Page 1',position=dict(index=1))])])], appearance=dict(fontScale=120,lineHeight=1.8,pageMargins=1,fontFamily='Georgia',theme='night',scroll=False))
            state = {'positions': {'sample': {'index': 1, 'progress': .25}}, 'bookPrefs': {'sample': {'fontSize': 23, 'theme': 'paper'}}}
            with patch.object(book_import,'BOOK_ROOT',books), patch.object(book_margins,'BOOK_ROOT',books), patch.object(translation,'BOOK_ROOT',books), patch.object(ai_tutor,'DATA',root), patch('paths.DATA',root):
                first = records.import_book(book,record,{image_path: original},state)
                self.assertEqual(first,{'excerpts':1,'translations':0,'conversations':1})
                local = book_margins.records(book)
                local['items'][0].update(note='Kept local edit', deletedAt=1794000001)
                save(directory/'margins.json',local)
                second = records.import_book(book,record,{image_path:original},state)
                self.assertEqual(second,{'excerpts':0,'translations':0,'conversations':0})
                exported = records.export_book(book,state)
                restored = exported['recordsData']
                self.assertEqual(restored['excerpts'][0]['note'],'Kept local edit')
                self.assertEqual(restored['excerpts'][0]['deletedAt'],1794000001)
                self.assertEqual(restored['excerpts'][0]['source']['rects'],source['rects'])
                self.assertEqual(restored['conversations'][0]['messages'][1]['references'][0]['position']['index'],1)
                self.assertEqual(exported['imagesData'][image_path],body)
                self.assertEqual(state['positions']['sample']['progress'],.25)
                self.assertEqual(state['bookPrefs']['sample']['fontSize'],23)

if __name__ == '__main__': unittest.main()
