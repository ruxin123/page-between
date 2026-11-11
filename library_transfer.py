"""Portable book/progress/bookmark exchange; independent of device backups and secrets."""
import hashlib
import json
import math
from pathlib import Path
import re
import uuid
import zipfile

FORMATS = {'epub', 'pdf', 'txt', 'fb2', 'cbz'}
MAX_FILE = 200 * 1024**2
MAX_TOTAL = 1024**3
MAX_RECORDS = 64 * 1024**2


def preview(books, path_for):
    ids, skipped, total = [], [], 0
    for book in books:
        if book.get("deletedAt"):
            continue
        source = path_for(book["originalUrl"])
        reason = None
        if source.suffix.lower().lstrip(".") not in FORMATS:
            reason = "手机暂不支持此格式"
        elif not source.is_file():
            reason = "原文件缺失"
        elif not 0 < source.stat().st_size <= MAX_FILE:
            reason = "单书超过 200 MB 或文件为空"
        if reason:
            skipped.append({"title": book["title"], "reason": reason})
        else:
            ids.append(book["id"])
            total += source.stat().st_size
    return {"books": len(ids), "ids": ids, "bytes": total, "skipped": skipped,
            "canExport": bool(ids) and len(ids) <= 5000 and total <= MAX_TOTAL}


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
    for key, limit in (("sourceOffset", 300000000), ("endIndex", 1000000)):
        if key in value:
            number = value[key]
            if type(number) is not int or not (index if key == "endIndex" else 0) <= number <= limit:
                raise ValueError("迁移原文锚点无效。")
            result[key] = number
    for key, limit in (("href", 2000), ("nativeMac", 6000), ("readium", 64000)):
        if key in value:
            raw = value[key]
            if not isinstance(raw, str) or len(raw.encode()) > limit:
                raise ValueError("迁移原文锚点过长。")
            if key != "href":
                try:
                    decoded = json.loads(raw)
                    if not isinstance(decoded, dict): raise ValueError()
                    if key == "nativeMac":
                        from library_data import validate_position
                        validate_position(decoded)
                except (ValueError, TypeError):
                    raise ValueError("迁移原文锚点无效。") from None
            result[key] = raw
    return result


def write(target, records):
    import transfer_records
    manifest = {'schema': 2, 'kind': 'page-between-transfer', 'books': [], 'images': []}
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=1) as out:
        total, record_bytes, written, required = 0, 0, set(), set()
        def asset(name, body, limit):
            nonlocal total, record_bytes
            if name not in written:
                total += len(body)
                if name.startswith("records/"): record_bytes += len(body)
                if record_bytes > MAX_RECORDS: raise ValueError("阅读记录超过 64 MB。")
                if not 0 < len(body) <= limit or total > MAX_TOTAL:
                    raise ValueError('迁移包超过限制：单书 200 MB、合计 1 GB。')
                out.writestr(name, body); written.add(name)
            return {'file': name, 'sha256': hashlib.sha256(body).hexdigest(), 'size': len(body)}
        for metadata, source in records:
            source = Path(source)
            size = source.stat().st_size
            if not 0 < size <= MAX_FILE:
                raise ValueError('迁移包超过限制：单书 200 MB、合计 1 GB。')
            digest = hashlib.sha256()
            with source.open('rb') as stream:
                while chunk := stream.read(1024 * 1024): digest.update(chunk)
            digest = digest.hexdigest()
            name = 'books/' + digest + source.suffix.lower()
            if name in written: continue
            total += size
            if total > MAX_TOTAL: raise ValueError('迁移包合计超过 1 GB。')
            out.write(source, name); written.add(name)
            record = {k: v for k, v in metadata.items() if k not in {'recordsData', 'imagesData'}}
            record.update(file=name, sha256=digest)
            if 'recordsData' in metadata:
                required |= transfer_records.validate(metadata['recordsData'])
                body = transfer_records.encoded(metadata['recordsData'])
                record['records'] = asset('records/' + hashlib.sha256(body).hexdigest() + '.json', body, 50 * 1024**2)
            for image, body in metadata.get('imagesData', {}).items():
                if not transfer_records.IMAGE.fullmatch(image) or hashlib.sha256(body).hexdigest() != Path(image).stem:
                    raise ValueError('迁移原图校验失败。')
                if image not in written: manifest['images'].append(asset(image, body, 4 * 1024**2))
            manifest['books'].append(record)
        if required != {item['file'] for item in manifest['images']}:
            raise ValueError('迁移原图引用不完整。')
        encoded = json.dumps(manifest, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if len(manifest['books']) > 5000 or len(encoded) > 4 * 1024**2:
            raise ValueError('迁移清单过大，请减少书籍或记录。')
        out.writestr('manifest.json', encoded)
    return len(manifest['books'])


def _read(source, folder):
    """Validate all bytes and record links before allowing any library mutation."""
    import transfer_records
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > 60001 or len({e.filename for e in entries}) != len(entries):
            raise ValueError('迁移包包含重复或过多文件。')
        def entry(name, limit):
            item = archive.getinfo(name)
            if not 0 < item.file_size <= limit or ((item.external_attr >> 16) & 0o170000) not in (0, 0o100000):
                raise ValueError('迁移包体积或文件类型无效。')
            return item
        meta = entry('manifest.json', 4 * 1024**2)
        manifest = json.loads(archive.read(meta))
        if not isinstance(manifest, dict) or manifest.get('schema') not in (1, 2) or manifest.get('kind') != 'page-between-transfer':
            raise ValueError('迁移包格式无效。')
        books, images = manifest.get('books'), manifest.get('images', [])
        if not isinstance(books, list) or len(books) > 5000 or not isinstance(images, list) or len(images) > 50000:
            raise ValueError('迁移清单无效。')
        expected, resources, total, record_bytes = {'manifest.json'}, {}, 0, 0
        def resource(value, prefix, extension, limit):
            nonlocal total, record_bytes
            if not isinstance(value, dict): raise ValueError('迁移资源无效。')
            name = value.get('file', '')
            if not isinstance(name, str) or not re.fullmatch(prefix + r'/[0-9a-f]{64}\.(' + extension + ')', name) or value.get('sha256') != Path(name).stem:
                raise ValueError('迁移资源路径或校验值无效。')
            item = entry(name, limit)
            if type(value.get('size')) is not int or value['size'] != item.file_size: raise ValueError('迁移资源体积无效。')
            if name not in resources:
                resources[name] = value
                expected.add(name); total += item.file_size
                if prefix == "records": record_bytes += item.file_size
                if record_bytes > MAX_RECORDS: raise ValueError("阅读记录超过 64 MB。")
            return name
        image_names = set()
        for image in images:
            name = resource(image, 'images', 'png|jpg', 4 * 1024**2)
            if name in image_names: raise ValueError('迁移原图重复。')
            image_names.add(name)
        for book in books:
            if not isinstance(book, dict): raise ValueError('迁移书籍无效。')
            book.pop('recordsData', None); book.pop('imagesData', None)
            name = book.get('file', '')
            if not isinstance(name, str) or not re.fullmatch(r'books/[0-9a-f]{64}\.(epub|pdf|txt|fb2|cbz)', name) or name in expected:
                raise ValueError('迁移书籍路径无效。')
            expected.add(name); total += entry(name, MAX_FILE).file_size
            if book.get('sha256') != Path(name).stem: raise ValueError('迁移书籍校验值无效。')
            if not all(isinstance(book.get(k, ''), str) and len(book.get(k, '')) <= 2000 for k in ('title', 'author')):
                raise ValueError('迁移元数据无效。')
            book['position'] = position(book.get('position', {}))
            marks = book.get('bookmarks', [])
            if not isinstance(marks, list) or len(marks) > 10000: raise ValueError('迁移书签无效。')
            for mark in marks:
                if not isinstance(mark, dict) or not isinstance(mark.get('title'), str) or len(mark['title']) > 2000: raise ValueError('迁移书签标题无效。')
                mark['position'] = position(mark.get('position', {}))
                if mark.get('id') is not None and (not isinstance(mark['id'], str) or not transfer_records.ID.fullmatch(mark['id'])): raise ValueError('迁移书签标识无效。')
                if mark.get('createdAt') is not None and not transfer_records._date(mark['createdAt']): raise ValueError('迁移书签时间无效。')
            if book.get('records') is not None: resource(book['records'], 'records', 'json', 50 * 1024**2)
        if total > MAX_TOTAL or expected != set(archive.namelist()):
            raise ValueError('迁移包超过 1 GB 或包含清单外文件。')
        for name in sorted(expected - {'manifest.json'}):
            target = Path(folder) / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(name) as incoming, target.open('wb') as output:
                digest = hashlib.sha256()
                while chunk := incoming.read(1024 * 1024): digest.update(chunk); output.write(chunk)
            if digest.hexdigest() != target.stem: raise ValueError('迁移文件校验失败。')
            if name.startswith('images/'):
                import book_images
                with book_images.inspect_image(target.read_bytes()) as image:
                    if (target.suffix == '.png') != (image.format == 'PNG'): raise ValueError('迁移原图类型无效。')
                    image.verify()
        required = set()
        for book in books:
            book['source'] = Path(folder) / book['file']
            if book.get('records') is not None:
                data = json.loads((Path(folder) / book['records']['file']).read_text('utf-8'))
                required |= transfer_records.validate(data)
                book['recordsData'] = data
            book['imagesData'] = {name: Path(folder) / name for name in image_names}
        if required != image_names: raise ValueError('迁移原图引用不完整。')
        return books


def read(source, folder):
    try:
        return _read(source, folder)
    except (zipfile.BadZipFile, KeyError, UnicodeDecodeError, json.JSONDecodeError, OSError, SyntaxError) as error:
        raise ValueError('迁移包无法读取或内容不完整，请重新选择。') from error
