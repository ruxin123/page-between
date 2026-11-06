"""Cross-read real Python and native transfer archives using production validators."""
from pathlib import Path
import argparse
import hashlib
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
    metadata=dict(title='原创读本',author='原创作者',position=position,bookmarks=[dict(title='第二章',position=position)])
    library_transfer.write(folder/'good.pbtransfer',[(metadata,source)])
    with zipfile.ZipFile(folder/'good.pbtransfer') as archive: entries={n:archive.read(n) for n in archive.namelist()}
    bookfile=next(n for n in entries if n.startswith('books/'))
    for name in ['tampered','extra','duplicate','symlink','traversal']:
        with zipfile.ZipFile(folder/(name+'.pbtransfer'),'w') as out:
            for path,data in entries.items():
                if name=='symlink' and path=='manifest.json':
                    entry=zipfile.ZipInfo(path);entry.create_system=3;entry.external_attr=0o120777<<16;out.writestr(entry,data)
                else: out.writestr(path,b'changed' if name=='tampered' and path==bookfile else data)
            if name=='extra': out.writestr('unknown.txt',b'unknown')
            if name=='duplicate': out.writestr('manifest.json',entries['manifest.json'])
            if name=='traversal': out.writestr('../outside',b'outside')
    subprocess.run(['swift','run','--package-path',str(scratch),'Fixture',str(folder)],check=True)
    recovered=library_transfer.read(folder/'native.pbtransfer',folder)
    assert recovered[0]['source'].read_bytes()==source.read_bytes()
    assert recovered[0]['position']==position
    print('Python → native → Python: original bytes, progress and bookmarks preserved')
