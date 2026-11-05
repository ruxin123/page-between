"""Portable book/progress/bookmark exchange; independent of device backups and secrets."""
import hashlib
import json
import math
from pathlib import Path
import re
import tempfile
import uuid
import zipfile

FORMATS = {'epub', 'pdf', 'txt', 'fb2', 'cbz'}
MAX_FILE = 200 * 1024**2
MAX_TOTAL = 1024**3


def position(value):
    if not isinstance(value, dict):
        raise ValueError('迁移位置无效。')
    index = value.get('index', 1)
    if type(index) is not int or not 1 <= index <= 1000000:
        raise ValueError('迁移页序无效。')
    result = {'index': index}
    for key in ('progress', 'chapterFraction', 'pdfY'):
        number = value.get(key, 0)
        if type(number) not in (int, float) or not math.isfinite(number) or not 0 <= number <= 1:
            raise ValueError('迁移进度无效。')
        result[key] = number
    return result


def write(target, records):
    manifest = {'schema': 1, 'kind': 'page-between-transfer', 'books': []}
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=1) as out:
        total = 0
        for metadata, source in records:
            source = Path(source)
            size = source.stat().st_size
            total += size
            if not 0 < size <= MAX_FILE or total > MAX_TOTAL:
                raise ValueError('迁移包超过限制：单书 200 MB、合计 1 GB。')
            hasher = hashlib.sha256()
            with source.open('rb') as stream:
                while chunk := stream.read(1024 * 1024): hasher.update(chunk)
            digest = hasher.hexdigest()
            name = 'books/' + digest + source.suffix.lower()
            if name not in out.namelist():
                out.write(source, name)
                manifest['books'].append({**metadata, 'file': name, 'sha256': digest})
        encoded = json.dumps(manifest, ensure_ascii=False).encode('utf-8')
        if len(manifest['books']) > 5000 or len(encoded) > 4 * 1024**2:
            raise ValueError('迁移清单过大，请减少书籍或书签。')
        out.writestr('manifest.json', encoded)
    return len(manifest['books'])


def _read(source, folder):
    """Validate every entry and checksum before allowing any library mutation."""
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > 5001 or len({e.filename for e in entries}) != len(entries):
            raise ValueError('迁移包包含重复或过多文件。')
        meta = archive.getinfo('manifest.json')
        if meta.file_size > 4 * 1024**2 or ((meta.external_attr >> 16) & 0o170000) not in (0, 0o100000):
            raise ValueError('迁移清单过大。')
        manifest = json.loads(archive.read(meta))
        if not isinstance(manifest, dict):
            raise ValueError('迁移清单无效。')
        books = manifest.get('books')
        if manifest.get('schema') != 1 or manifest.get('kind') != 'page-between-transfer' or not isinstance(books, list) or len(books) > 5000:
            raise ValueError('迁移包格式无效。')
        expected = {'manifest.json'}
        total = 0
        for book in books:
            if not isinstance(book, dict):
                raise ValueError('迁移书籍无效。')
            name = book.get('file', '')
            if not re.fullmatch(r'books/[0-9a-f]{64}\.(epub|pdf|txt|fb2|cbz)', name) or name in expected:
                raise ValueError('迁移书籍路径无效。')
            expected.add(name)
            entry = archive.getinfo(name)
            total += entry.file_size
            if not 0 < entry.file_size <= MAX_FILE or total > MAX_TOTAL or ((entry.external_attr >> 16) & 0o170000) not in (0, 0o100000):
                raise ValueError('迁移包体积或文件类型无效。')
            if not all(isinstance(book.get(k, ''), str) and len(book.get(k, '')) <= 2000 for k in ('title', 'author')):
                raise ValueError('迁移元数据无效。')
            book['position'] = position(book.get('position', {}))
            marks = book.get('bookmarks', [])
            if not isinstance(marks, list) or len(marks) > 10000:
                raise ValueError('迁移书签无效。')
            for mark in marks:
                if not isinstance(mark, dict) or not isinstance(mark.get('title'), str) or len(mark['title']) > 2000:
                    raise ValueError('迁移书签标题无效。')
                mark['position'] = position(mark.get('position', {}))
        if expected != set(archive.namelist()):
            raise ValueError('迁移包包含清单外文件。')
        for book in books:
            target = Path(folder) / Path(book['file']).name
            with archive.open(book['file']) as incoming, target.open('wb') as output:
                digest = hashlib.sha256()
                while chunk := incoming.read(1024 * 1024):
                    digest.update(chunk); output.write(chunk)
            if digest.hexdigest() != book.get('sha256') or digest.hexdigest() != target.stem:
                raise ValueError('迁移书籍校验失败。')
            book['source'] = target
        return books


def read(source, folder):
    try:
        return _read(source, folder)
    except (zipfile.BadZipFile, KeyError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError('迁移包无法读取或内容不完整，请重新选择。') from error
