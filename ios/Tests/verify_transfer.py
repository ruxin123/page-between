"""Cross-read real Python and native transfer archives using production validators."""
from pathlib import Path
import argparse
import hashlib
import io
from PIL import Image
import json
import subprocess
import sys
import tempfile
import zipfile

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root))
import library_transfer
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--zipfoundation', type=Path)
args = parser.parse_args()
scratch = Path.home() / 'Library/Caches/Page Between/iOS/TransferTests'
sources = scratch/'Sources/Fixture'; sources.mkdir(parents=True, exist_ok=True)
files = [*(root / 'ios/PageBetween/Core').glob('*.swift'), root / 'ios/PageBetween/App/TransferArchive.swift', root / 'ios/Tests/TransferFixture.swift']
for source in files:
    if source.name.startswith('._'):
        continue
    link=sources/source.name
    if not link.exists(): link.symlink_to(source)
dependency = args.zipfoundation or scratch.parent/'CompileCheck/.build/checkouts/ZIPFoundation'
(scratch/'Package.swift').write_text('''// swift-tools-version:5.10
import PackageDescription
let package = Package(name:"TransferFixture",platforms:[.macOS(.v14)],dependencies:[.package(path:__PATH__)],targets:[.executableTarget(name:"Fixture",dependencies:[.product(name:"ReadiumZIPFoundation",package:"ZIPFoundation")])])
'''.replace('__PATH__',json.dumps(str(dependency.resolve()))))
with tempfile.TemporaryDirectory(dir=scratch) as folder:
    folder=Path(folder); source=folder/'original.txt'; source.write_text('Original transfer content.\n')
    position=dict(index=2,progress=.4,chapterFraction=.3,pdfY=0)
    buffer = io.BytesIO(); Image.new('RGB', (4, 4), (83, 125, 104)).save(buffer, format='PNG'); png = buffer.getvalue()
    image = 'images/' + hashlib.sha256(png).hexdigest() + '.png'
    origin = dict(quote='An original $x^2$ example.', markdown='An original $x^2$ example.', position=position, kind='text', chapter='第二章', images=[dict(file=image, raw='$x^2$')], objects=[], rects=[])
    stamp = 1794000000
    records = dict(schema=1, excerpts=[dict(id='a'*32, source=origin, note='原创笔记', createdAt=stamp)],
        translations=[dict(id='b'*32, source=origin, text=origin['quote'], translation='原创译文 $x^2$。', explanation='', provider='google', model='', sourceLanguage='en', targetLanguage='zh', detectedLanguage='en', createdAt=stamp)],
        conversations=[dict(id='c'*32, source=origin, createdAt=stamp, updatedAt=stamp, messages=[dict(id='d'*32, role='user', content='Original question'), dict(id='e'*32, role='assistant', content='Original answer [3].', status='complete', references=[dict(number=3, text='Original reference', citation='第二章', position=position)])])],
        appearance=dict(fontScale=110, lineHeight=1.8, pageMargins=1, fontFamily='Georgia', theme='night', scroll=False))
    metadata=dict(title='原创读本',author='原创作者',position=position,bookmarks=[dict(title='第二章',position=position)],recordsData=records,imagesData={image:png})
    library_transfer.write(folder/'good.pbtransfer',[(metadata,source)])
    with zipfile.ZipFile(folder/'good.pbtransfer') as archive: entries={n:archive.read(n) for n in archive.namelist()}
    bookfile=next(n for n in entries if n.startswith('books/'))
    with zipfile.ZipFile(folder/'legacy.pbtransfer','w') as out:
        out.writestr(bookfile,entries[bookfile])
        out.writestr('manifest.json',json.dumps(dict(schema=1,kind='page-between-transfer',books=[dict(title='Legacy',author='',position=position,bookmarks=[],file=bookfile,sha256=Path(bookfile).stem)])))
    assert library_transfer.read(folder/'legacy.pbtransfer',folder/'legacy-python')[0]['position'] == position
    for name in ['tampered','asset','record','extra','duplicate','symlink','traversal']:
        with zipfile.ZipFile(folder/(name+'.pbtransfer'),'w') as out:
            for path,data in entries.items():
                if name=='symlink' and path=='manifest.json':
                    entry=zipfile.ZipInfo(path);entry.create_system=3;entry.external_attr=0o120777<<16;out.writestr(entry,data)
                else:
                    damaged = name=='tampered' and path==bookfile or name=='asset' and path.startswith('images/') or name=='record' and path.startswith('records/')
                    out.writestr(path,b'changed' if damaged else data)
            if name=='extra': out.writestr('unknown.txt',b'unknown')
            if name=='duplicate': out.writestr('manifest.json',entries['manifest.json'])
            if name=='traversal': out.writestr('../outside',b'outside')
    subprocess.run(['swift','run','--package-path',str(scratch),'Fixture',str(folder)],check=True)
    recovered=library_transfer.read(folder/'native.pbtransfer',folder)
    assert recovered[0]['source'].read_bytes()==source.read_bytes()
    assert recovered[0]['position']==position
    assert recovered[0]['recordsData'] == records
    assert recovered[0]['imagesData'][image].read_bytes() == png
    print('Python → native → Python: original bytes, progress, bookmarks, notes, translation, conversation references, appearance and raster attachment preserved')
