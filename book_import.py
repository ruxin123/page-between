"""Local format adapters. EPUB content is retained, not flattened into TXT."""

import hashlib
import json
import mimetypes
import re
import shutil
import subprocess
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import quote, unquote, urlsplit

from lxml import etree
from pypdf import PdfReader

from paths import ROOT, BOOK_ROOT, DATA_PREFIX
from storage import save

XML = etree.XMLParser(resolve_entities=False, no_network=True)
OPF = {"o": "http://www.idpf.org/2007/opf", "dc": "http://purl.org/dc/elements/1.1/"}
NCX = {"n": "http://www.daisy.org/z3986/2005/ncx/"}
CONVERT = {
    ".md": "markdown",
    ".markdown": "markdown",
    ".html": "html",
    ".htm": "html",
    ".fb2": "fb2",
    ".docx": "docx",
    ".odt": "odt",
    ".rtf": "rtf",
}
SUPPORTED = {".pdf", ".epub", ".txt", ".cbz", ".mobi", ".azw", ".azw3", *CONVERT}


def defaults(extension):
    return extension.lower() in {".pdf", ".txt"}


def safe_target(base, href, root):
    link = urlsplit(href)
    if link.scheme or link.netloc:
        raise ValueError("书籍资源必须位于本地书籍包中。")
    target = (base / unquote(link.path)).resolve()
    if not target.is_relative_to(root.resolve()):
        raise ValueError("书籍资源超出了文件包范围。")
    return target


def extract_zip(source, destination):
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if (
            len(entries) > 15000
            or sum(item.file_size for item in entries) > 600 * 1024 * 1024
        ):
            raise ValueError("文件包过大，请使用较小的书籍。")
        for item in entries:
            if item.filename.startswith("__MACOSX/") or PurePosixPath(
                item.filename
            ).name.startswith("._"):
                continue
            target = safe_target(destination, item.filename, destination)
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(item) as input_file, target.open("wb") as output:
                    shutil.copyfileobj(input_file, output)


def url_for(path):
    return (
        DATA_PREFIX
        + "/books/"
        + quote(path.resolve().relative_to(BOOK_ROOT.resolve()).as_posix())
    )


def path_for(url):
    path = urlsplit(url)
    prefix = DATA_PREFIX + "/books/"
    if path.scheme or path.netloc or not path.path.startswith(prefix):
        raise ValueError("书籍资源地址无效。")
    return safe_target(BOOK_ROOT, path.path[len(prefix) :], BOOK_ROOT)


def epub_metadata(content):
    container = etree.parse(str(content / "META-INF/container.xml"), XML)
    opf_path = safe_target(
        content,
        container.xpath('string(//*[local-name()="rootfile"]/@full-path)'),
        content,
    )
    package = etree.parse(str(opf_path), XML)
    manifest = {
        item.get("id"): item
        for item in package.xpath("//o:manifest/o:item", namespaces=OPF)
    }
    spine = package.xpath("//o:spine", namespaces=OPF)[0]
    chapters, indexes = [], {}
    for reference in spine:
        item = manifest.get(reference.get("idref"))
        if item is None or reference.get("linear") == "no":
            continue
        path = safe_target(opf_path.parent, item.get("href"), content)
        if not path.is_file():
            raise ValueError("EPUB 缺少正文文件。")
        try:
            document = etree.parse(str(path), XML)
        except etree.XMLSyntaxError as error:
            raise ValueError("EPUB 正文无法读取，可能损坏或受到保护。") from error
        title = document.xpath(
            'string(//*[local-name()="head"]/*[local-name()="title"])'
        ).strip()
        body = document.xpath('//*[local-name()="body"]')
        characters = sum(len("".join(element.itertext())) for element in body)
        indexes[path.resolve()] = len(chapters) + 1
        chapters.append(
            {
                "title": title or f"第 {len(chapters) + 1} 页",
                "url": url_for(path),
                "characters": max(1, characters),
                "body": "",
            }
        )
    if not chapters:
        raise ValueError("EPUB 没有可阅读的正文。")

    def destination(base, href):
        if urlsplit(href).scheme or urlsplit(href).netloc:
            return None, ""
        target = safe_target(base, href, content)
        return indexes.get(target), unquote(urlsplit(href).fragment)

    def ncx_items(parent, base):
        result = []
        for node in parent.findall("n:navPoint", NCX):
            title = node.findtext(
                "n:navLabel/n:text", default="", namespaces=NCX
            ).strip()
            target = node.find("n:content", NCX)
            index, fragment = (
                destination(base, target.get("src"))
                if target is not None
                else (None, "")
            )
            result.append(
                {
                    "title": title,
                    "index": index,
                    "fragment": fragment,
                    "children": ncx_items(node, base),
                }
            )
        return result

    def nav_items(ordered_list, base):
        result = []
        for node in ordered_list:
            if not isinstance(node.tag, str) or etree.QName(node).localname != "li":
                continue
            label = next(
                (
                    child
                    for child in node
                    if isinstance(child.tag, str)
                    and etree.QName(child).localname in {"a", "span"}
                ),
                None,
            )
            if label is None:
                continue
            title = "".join(label.itertext()).strip()
            index, fragment = (
                destination(base, label.get("href"))
                if label.get("href")
                else (None, "")
            )
            nested = next(
                (
                    child
                    for child in node
                    if isinstance(child.tag, str)
                    and etree.QName(child).localname == "ol"
                ),
                None,
            )
            result.append(
                {
                    "title": title,
                    "index": index,
                    "fragment": fragment,
                    "children": nav_items(nested, base) if nested is not None else [],
                }
            )
        return result

    nav = next(
        (
            item
            for item in manifest.values()
            if "nav" in item.get("properties", "").split()
        ),
        None,
    )
    toc, toc_source = [], "spine"
    if nav is not None:
        path = safe_target(opf_path.parent, nav.get("href"), content)
        document = etree.parse(str(path), XML)
        ordered = document.xpath(
            '//*[local-name()="nav" and contains(@*[local-name()="type"],"toc")]/*[local-name()="ol"]'
        )
        if ordered:
            toc = nav_items(ordered[0], path.parent)
            toc_source = "epub-nav"
    if not toc and spine.get("toc") in manifest:
        path = safe_target(
            opf_path.parent, manifest[spine.get("toc")].get("href"), content
        )
        document = etree.parse(str(path), XML)
        nav_map = document.find("n:navMap", NCX)
        if nav_map is not None:
            toc = ncx_items(nav_map, path.parent)
            toc_source = "epub-ncx"
    if not toc:
        toc = [
            {
                "title": chapter["title"],
                "index": index + 1,
                "fragment": "",
                "children": [],
            }
            for index, chapter in enumerate(chapters)
        ]
    for item in flatten_toc(toc):
        if item["index"] and item["title"]:
            chapter = chapters[item["index"] - 1]
            if not chapter.get("named") or not item.get("children"):
                chapter["title"], chapter["named"] = item["title"], True
    cover_id = package.xpath('string(//o:meta[@name="cover"]/@content)', namespaces=OPF)
    cover = manifest.get(cover_id)
    if cover is None:
        cover = next(
            (
                item
                for item in manifest.values()
                if "cover-image" in item.get("properties", "").split()
            ),
            None,
        )
    cover_url = (
        url_for(safe_target(opf_path.parent, cover.get("href"), content))
        if cover is not None
        else None
    )
    metadata = {
        "type": "epub",
        "title": package.xpath("string(//dc:title)", namespaces=OPF).strip(),
        "author": "、".join(package.xpath("//dc:creator/text()", namespaces=OPF)),
        "language": package.xpath("string(//dc:language)", namespaces=OPF) or "zh",
        "layout": package.xpath(
            'string(//o:meta[@property="rendition:layout"])', namespaces=OPF
        )
        or "reflowable",
        "cover": cover_url,
        "chapters": chapters,
        "toc": toc,
        "tocSource": toc_source,
    }
    marker = content / "META-INF/page-between.json"
    if marker.is_file() and marker.stat().st_size <= 100000:
        try:
            source = json.loads(marker.read_text())
            pages = source.get("pages", [])
            if (
                source.get("schema") == 1
                and re.fullmatch(r"[0-9a-f]{64}", source.get("sourceHash", ""))
                and isinstance(pages, list)
                and pages
                and all(type(page) is int and 1 <= page <= 100000 for page in pages)
            ):
                metadata.update(
                    sourcePdfHash=source["sourceHash"], sourcePdfPages=pages
                )
                for chapter in chapters:
                    root = etree.parse(str(path_for(chapter["url"])), XML)
                    markers = root.xpath('//*[starts-with(@id,"pdf-page-")]/@id')
                    if markers and re.fullmatch(r"pdf-page-\d+", markers[0]):
                        page = int(markers[0].removeprefix("pdf-page-"))
                        if page in pages:
                            chapter["sourcePdfPage"] = page
        except (ValueError, TypeError, AttributeError):
            pass
    return metadata


def flatten_toc(items):
    for item in items:
        yield item
        yield from flatten_toc(item.get("children", []))


def decode_text(data):
    for encoding in (
        ["utf-16"]
        if data.startswith((b"\xff\xfe", b"\xfe\xff"))
        else ["utf-8-sig", "gb18030"]
    ):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            pass
    raise ValueError("文字编码无法识别，请保存为 UTF-8 后重试。")


def html_metadata(source):
    document = etree.parse(str(source), etree.HTMLParser(no_network=True))
    title = document.xpath("string(//title)").strip() or source.stem
    toc = []
    for index, element in enumerate(document.xpath("//h1|//h2|//h3")):
        anchor = element.get("id") or f"reader-heading-{index}"
        element.set("id", anchor)
        toc.append(
            {
                "title": "".join(element.itertext()).strip(),
                "index": 1,
                "fragment": anchor,
                "children": [],
            }
        )
    source.write_bytes(etree.tostring(document, method="html", encoding="utf-8"))
    body = document.xpath("//body")
    length = len("".join(body[0].itertext())) if body else 1
    return {
        "type": "epub",
        "title": title,
        "author": "本地导入",
        "language": "zh",
        "layout": "reflowable",
        "chapters": [
            {
                "title": title,
                "url": url_for(source),
                "characters": max(1, length),
                "body": "",
            }
        ],
        "toc": toc or [{"title": title, "index": 1, "fragment": "", "children": []}],
        "tocSource": "html-headings",
    }


def text_toc(chapters):
    toc = []
    for index, chapter in enumerate(chapters):
        item = {
            "title": chapter["title"],
            "index": index + 1,
            "fragment": "",
            "children": [],
        }
        if chapter.get("volume"):
            if not toc or toc[-1]["title"] != chapter["volume"]:
                toc.append(
                    {
                        "title": chapter["volume"],
                        "index": index + 1,
                        "fragment": "",
                        "children": [],
                    }
                )
            toc[-1]["children"].append(item)
        else:
            toc.append(item)
    return toc


def text_chapter_index(book, offset):
    if type(offset) is not int or not 0 <= offset <= 1000000000:
        raise ValueError("原文字符位置无效。")
    return max(
        [
            index
            for index, chapter in enumerate(book.get("chapters", []), 1)
            if chapter.get("sourceOffset", 0) <= offset
        ]
        or [1]
    )


def text_metadata(source, destination, enabled):
    text = decode_text(source.read_bytes())
    if not text.strip():
        raise ValueError("文件中没有可阅读的文字。")
    node = shutil.which("node")
    if not node:
        raise ValueError("需要 Node.js 才能建立 TXT 章节索引。")
    parsed = subprocess.run(
        [node, str(ROOT / "parse_text.mjs")],
        input=json.dumps({"text": text, "enabled": enabled}),
        text=True,
        capture_output=True,
        check=True,
        timeout=40,
    )
    chapters = json.loads(parsed.stdout)
    output = destination / "text.json"
    save(output, chapters)
    return {
        "type": "txt",
        "title": source.stem,
        "author": "本地导入",
        "language": "zh" if re.search(r"[\u4e00-\u9fff]", text) else "en",
        "toc": text_toc(chapters),
        "chapters": [{**chapter, "body": ""} for chapter in chapters],
        "contentUrl": url_for(output),
        "tocSource": "txt-rules" if enabled else "text",
    }


def pdf_metadata(source):
    from pdf_enhancement import tree_from_entries

    reader = PdfReader(source)
    if reader.is_encrypted and not reader.decrypt(""):
        raise ValueError("PDF 需要密码，请先导入可直接打开的副本。")
    toc = []

    def walk(items, level=0):
        for item in items:
            if isinstance(item, list):
                walk(item, level + 1)
            else:
                number = reader.get_destination_page_number(item)
                if number is not None and number >= 0:
                    toc.append(
                        {
                            "title": item.title,
                            "index": number + 1,
                            "printed": "",
                            "level": level,
                        }
                    )

    walk(reader.outline)
    if (
        toc
        and sum(
            bool(re.match(r"^(?:扫描书|Page\s*\d|[0-9A-F]{8,})", item["title"], re.I))
            for item in toc
        )
        > len(toc) * 0.7
    ):
        toc = []
    return {
        "type": "pdf",
        "title": source.stem,
        "author": reader.metadata.author or "本地导入",
        "pages": len(reader.pages),
        "url": url_for(source),
        "toc": tree_from_entries(toc),
        "tocSource": "pdf-outline" if toc else "pending",
        "pageOffset": None,
        "language": "zh" if re.search(r"[\u4e00-\u9fff]", source.stem) else "en",
    }


def import_book(source, *, enabled=None, ident=None, title=None, shelf=None):
    extension = source.suffix.lower()
    if extension not in SUPPORTED:
        raise ValueError("暂不支持这个文件格式。")
    enabled = defaults(extension) if enabled is None else enabled
    digest = hashlib.sha256()
    if source.is_dir():
        for file in sorted(source.rglob("*")):
            if (
                file.is_file()
                and not file.name.startswith("._")
                and file.suffix != ".plist"
            ):
                digest.update(file.relative_to(source).as_posix().encode())
                digest.update(file.read_bytes())
    else:
        with source.open("rb") as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                digest.update(chunk)
    ident = ident or digest.hexdigest()[:24]
    destination = BOOK_ROOT / ident
    destination.mkdir(parents=True, exist_ok=True)
    original = destination / ("original" + extension)
    if source.is_file() and source.resolve() != original.resolve():
        shutil.copy2(source, original)
    if extension == ".pdf":
        metadata = pdf_metadata(original)
    elif extension == ".txt":
        metadata = text_metadata(original, destination, enabled)
    else:
        content = destination / "content"
        content.mkdir(exist_ok=True)
        if extension in {".mobi", ".azw", ".azw3"}:
            import mobi
            import contextlib, io

            temporary = None
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    temporary, extracted = mobi.extract(str(original))
                extracted = Path(extracted)
                if extracted.suffix == ".epub":
                    extract_zip(extracted, content)
                    metadata = epub_metadata(content)
                elif extracted.suffix == ".html":
                    shutil.copytree(extracted.parent, content, dirs_exist_ok=True)
                    metadata = html_metadata(content / extracted.name)
                elif extracted.suffix == ".pdf":
                    target = destination / "render.pdf"
                    shutil.copy2(extracted, target)
                    metadata = pdf_metadata(target)
                else:
                    raise ValueError("此 Kindle 文件没有可阅读的正文。")
            except Exception as error:
                raise ValueError(
                    "Kindle 文件无法导入，请使用完整、可直接读取的版本。"
                ) from error
            finally:
                if temporary:
                    shutil.rmtree(temporary, ignore_errors=True)
        elif extension == ".epub":
            if source.is_dir():
                # Only package assets are copied; Apple account metadata is excluded.
                container = etree.parse(str(source / "META-INF/container.xml"), XML)
                package_path = safe_target(
                    source,
                    container.xpath('string(//*[local-name()="rootfile"]/@full-path)'),
                    source,
                )
                package = etree.parse(str(package_path), XML)
                resources = [source / "META-INF/container.xml", package_path]
                resources += [
                    safe_target(package_path.parent, item.get("href"), source)
                    for item in package.xpath("//o:manifest/o:item", namespaces=OPF)
                ]
                for resource in resources:
                    target = content / resource.relative_to(source)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if resource.is_file():
                        shutil.copy2(resource, target)
                with zipfile.ZipFile(original, "w", zipfile.ZIP_DEFLATED) as archive:
                    archive.writestr("mimetype", "application/epub+zip")
                    for file in resources:
                        if file.is_file():
                            archive.write(file, file.relative_to(source).as_posix())
            else:
                extract_zip(original, content)
        elif extension == ".cbz":
            extract_zip(original, content)
            images = sorted(
                (
                    file
                    for file in content.rglob("*")
                    if not file.name.startswith("._")
                    and file.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
                ),
                key=lambda p: [
                    int(s) if s.isdigit() else s
                    for s in re.split(r"(\d+)", p.as_posix())
                ],
            )
            if not images:
                raise ValueError("漫画文件包中没有图片。")
            chapters = []
            for index, image in enumerate(images):
                html = content / f"page-{index + 1}.html"
                html.write_text(
                    '<!doctype html><html><head><meta charset="utf-8"></head><body><img style="width:100%;height:auto" src="'
                    + url_for(image)
                    + '"></body></html>',
                    encoding="utf-8",
                )
                chapters.append(
                    {
                        "title": f"第 {index + 1} 页",
                        "url": url_for(html),
                        "body": "",
                        "characters": 1,
                    }
                )
            metadata = {
                "type": "epub",
                "layout": "comic",
                "title": source.stem,
                "author": "本地导入",
                "language": "zh",
                "cover": url_for(images[0]),
                "chapters": chapters,
                "toc": [
                    {
                        "title": c["title"],
                        "index": i + 1,
                        "fragment": "",
                        "children": [],
                    }
                    for i, c in enumerate(chapters)
                ],
                "tocSource": "image-order",
            }
        else:
            converted = destination / "converted.epub"
            pandoc = shutil.which("pandoc")
            if not pandoc:
                raise ValueError("这个格式需要先安装 Pandoc。")
            try:
                subprocess.run(
                    [
                        pandoc,
                        str(original),
                        "--sandbox",
                        "--from=" + CONVERT[extension],
                        "--to=epub3",
                        "--lua-filter=" + str(ROOT / "normalize-headings.lua"),
                        "--resource-path=" + str(source.parent),
                        "-o",
                        str(converted),
                    ],
                    capture_output=True,
                    text=True,
                    check=True,
                    timeout=90,
                )
            except subprocess.CalledProcessError as error:
                raise ValueError("文件转换失败，请检查文件是否完整。") from error
            extract_zip(converted, content)
        if extension not in {".cbz", ".mobi", ".azw", ".azw3"}:
            metadata = epub_metadata(content)
    native_title = metadata.get("title")
    metadata.update(
        {
            "id": ident,
            "title": title
            or (
                native_title
                if native_title not in {"", "original", "converted", None}
                else source.stem
            ),
            "format": extension[1:].upper(),
            "parseEnabled": enabled,
            "shelf": shelf or ("学习" if extension == ".pdf" else "小说"),
            "onShelf": extension == ".pdf",
            "originalUrl": url_for(original),
            "sourceHash": digest.hexdigest(),
            "processing": "pending"
            if extension == ".pdf" and enabled and not metadata["toc"]
            else "ready",
        }
    )
    if extension == ".pdf":
        metadata["language"] = (
            "zh" if re.search(r"[\u4e00-\u9fff]", metadata["title"]) else "en"
        )
    save(destination / "book.json", metadata)
    return metadata
