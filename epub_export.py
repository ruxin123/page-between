"""Export reflowable books while keeping original PDF page anchors."""

import html
import json
import posixpath
import re
import shutil
import subprocess
import tempfile
import uuid
import zipfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit

from lxml import etree
from pypdf import PdfReader

from book_import import BOOK_ROOT, flatten_toc, path_for
from book_index import REFERENCE, references
from paths import CACHE
from pdf_enhancement import enrichment_data, PDF_LOCK, open_pdf
from storage import load


def complete_package(path):
    """Check local package links and fill missing packaging metadata, not book content.

    This is an export preflight, not a replacement for EPUBCheck. A compliant native
    book stays byte-for-byte unchanged. Repairs only affect the exported copy.
    """
    container_ns = "urn:oasis:names:tc:opendocument:xmlns:container"
    opf_ns = "http://www.idpf.org/2007/opf"
    xml = etree.XMLParser(resolve_entities=False, no_network=True)
    replacements = {}
    temporary = path.with_suffix(".packaging.tmp")
    try:
        with zipfile.ZipFile(path) as source:
            entries = source.infolist()
            names = {item.filename for item in entries}
            if len(names) != len(entries):
                raise ValueError("EPUB 包内存在重复文件，无法安全导出。")

            def read_xml(name):
                return etree.fromstring(source.read(name), xml)

            def local_resource(base, href):
                link = urlsplit(href or "")
                if link.scheme or link.netloc or link.path.startswith("/"):
                    raise ValueError("EPUB 正文入口必须是包内文件。")
                name = posixpath.normpath(posixpath.join(base, unquote(link.path)))
                if name.startswith("../") or name not in names:
                    raise ValueError("EPUB 缺少正文或目录资源，无法导出完整副本。")
                return name

            container = read_xml("META-INF/container.xml")
            if container.tag != f"{{{container_ns}}}container":
                raise ValueError("EPUB 容器格式无法读取。")
            changed = False
            if not container.get("version"):
                container.set("version", "1.0")
                changed = True
            roots = container.findall(
                f"{{{container_ns}}}rootfiles/{{{container_ns}}}rootfile"
            )
            if not roots:
                raise ValueError("EPUB 缺少正文入口。")
            packages = 0
            for root in roots:
                if not root.get("media-type"):
                    root.set("media-type", "application/oebps-package+xml")
                    changed = True
                if root.get("media-type") != "application/oebps-package+xml":
                    continue
                packages += 1
                name = local_resource("", root.get("full-path"))
                package = read_xml(name)
                if package.tag != f"{{{opf_ns}}}package":
                    raise ValueError("EPUB 出版信息无法读取。")
                metadata = package.find(f"{{{opf_ns}}}metadata")
                manifest = package.find(f"{{{opf_ns}}}manifest")
                spine = package.find(f"{{{opf_ns}}}spine")
                if (
                    metadata is None
                    or manifest is None
                    or spine is None
                    or not len(spine)
                ):
                    raise ValueError("EPUB 缺少出版信息或阅读顺序。")
                items = {item.get("id"): item for item in manifest}
                for item in spine:
                    if item.get("idref") not in items:
                        raise ValueError("EPUB 阅读顺序引用了缺失的章节。")
                package_changed = False
                epub3 = package.get("version", "").startswith("3.")
                if epub3 and not metadata.findall(
                    f"{{{opf_ns}}}meta[@property='dcterms:modified']"
                ):
                    modified = etree.SubElement(
                        metadata, f"{{{opf_ns}}}meta", property="dcterms:modified"
                    )
                    modified.text = datetime.now(timezone.utc).strftime(
                        "%Y-%m-%dT%H:%M:%SZ"
                    )
                    package_changed = True
                for item in manifest:
                    if item.get("media-type") != "application/xhtml+xml":
                        continue
                    chapter = read_xml(
                        local_resource(posixpath.dirname(name), item.get("href"))
                    )
                    if epub3:
                        properties = item.get("properties", "").split()
                        for flag, namespace in (
                            ("mathml", "http://www.w3.org/1998/Math/MathML"),
                            ("svg", "http://www.w3.org/2000/svg"),
                        ):
                            if flag not in properties and chapter.xpath(
                                "boolean(//*[namespace-uri()=$ns])", ns=namespace
                            ):
                                properties.append(flag)
                                item.set("properties", " ".join(properties))
                                package_changed = True
                if package_changed:
                    replacements[name] = etree.tostring(
                        package, encoding="UTF-8", xml_declaration=True
                    )
            if not packages:
                raise ValueError("EPUB 容器没有声明可读取的正文入口。")
            if changed:
                replacements["META-INF/container.xml"] = etree.tostring(
                    container, encoding="UTF-8", xml_declaration=True
                )
            mimetype_ok = (
                bool(entries)
                and entries[0].filename == "mimetype"
                and entries[0].compress_type == zipfile.ZIP_STORED
                and not entries[0].extra
                and source.read("mimetype") == b"application/epub+zip"
            )
            if not replacements and mimetype_ok:
                return False
            if "META-INF/signatures.xml" in names:
                raise ValueError("此 EPUB 带有数字签名，无法自动调整其出版信息。")
            with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as target:
                target.writestr(
                    "mimetype",
                    b"application/epub+zip",
                    compress_type=zipfile.ZIP_STORED,
                )
                for item in entries:
                    if item.filename == "mimetype":
                        continue
                    if item.filename in replacements:
                        target.writestr(item, replacements[item.filename])
                    else:
                        with (
                            source.open(item) as incoming,
                            target.open(item, "w") as outgoing,
                        ):
                            shutil.copyfileobj(incoming, outgoing)
        temporary.replace(path)
        return True
    except (KeyError, etree.XMLSyntaxError, zipfile.BadZipFile):
        raise ValueError("EPUB 包结构不完整，无法导出；请检查原文件。") from None
    finally:
        temporary.unlink(missing_ok=True)


def filename(title, extension):
    return (
        re.sub(r"[\x00-\x1f/\\:]", "_", title).strip(". ")[:120] or "页间导出"
    ) + extension


def table_html(value):
    if not value.strip():
        return ""
    root = etree.fromstring(value.encode(), etree.HTMLParser(no_network=True))
    tables = root.xpath("//table")
    if not tables:
        return ""
    table = tables[0]
    allowed = {
        "table",
        "thead",
        "tbody",
        "tfoot",
        "tr",
        "th",
        "td",
        "p",
        "br",
        "em",
        "strong",
        "span",
        "sup",
        "sub",
    }
    for node in list(table.iter()):
        if not isinstance(node.tag, str) or node.tag in {
            "script",
            "style",
            "iframe",
            "object",
        }:
            if node.getparent() is not None:
                node.getparent().remove(node)
            continue
        if node.tag not in allowed:
            node.tag = "span"
        for name in list(node.attrib):
            if name not in {"colspan", "rowspan"} or not re.fullmatch(
                r"[1-9]\d?", node.get(name)
            ):
                del node.attrib[name]
    return etree.tostring(table, encoding="unicode", method="html")


def image_for(document, page_number, bbox, target):
    with PDF_LOCK, closing(document[page_number - 1]) as page:
        bitmap = page.render(scale=min(2, 1800 / page.get_width()))
        image = bitmap.to_pil()
        left, top, right, bottom = bbox
        image.crop(
            (
                int(left * image.width),
                int(top * image.height),
                max(1, int(right * image.width)),
                max(1, int(bottom * image.height)),
            )
        ).save(target, format="PNG")
        bitmap.close()


def linked_text(text, targets, current):
    result, start = [], 0
    for match in REFERENCE.finditer(text):
        result.append(html.escape(text[start : match.start()]))
        key = references(match[0])[0][0]
        destinations = targets.get(key, [])
        if len(destinations) == 1 and destinations[0] != current:
            result.append(
                '<a href="#' + destinations[0] + '">' + html.escape(match[0]) + "</a>"
            )
        else:
            result.append(html.escape(match[0]))
        start = match.end()
    result.append(html.escape(text[start:]))
    return "".join(result)


def package_original(book, target):
    folder = BOOK_ROOT / book["id"]
    if book.get("format") == "EPUB":
        shutil.copyfile(path_for(book["originalUrl"]), target)
        return True
    converted = folder / "converted.epub"
    if converted.is_file():
        shutil.copyfile(converted, target)
        return True
    content = folder / "content"
    if (content / "META-INF/container.xml").is_file():
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(
                "mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED
            )
            for path in content.rglob("*"):
                if (
                    path.is_file()
                    and path.name != "mimetype"
                    and not path.name.startswith(".")
                ):
                    archive.write(path, path.relative_to(content).as_posix())
        return True
    return False


def failed_math(path, blocks):
    failed = set()
    with zipfile.ZipFile(path) as archive:
        for name in archive.namelist():
            if not name.endswith(".xhtml"):
                continue
            root = etree.fromstring(
                archive.read(name),
                etree.XMLParser(resolve_entities=False, no_network=True),
            )
            for node in root.xpath(
                '//*[contains(concat(" ",normalize-space(@class)," ")," math ") and not(.//*[local-name()="math"]) and local-name()!="math"]'
            ):
                anchor = next(
                    (
                        parent.get("id")
                        for parent in [node, *node.iterancestors()]
                        if parent.get("id") in blocks
                    ),
                    None,
                )
                if anchor:
                    failed.add(anchor)
            for node in root.xpath("//*[@id]"):
                block = blocks.get(node.get("id"))
                if (
                    block
                    and block["type"] == "equation"
                    and not node.xpath('.//*[local-name()="math"]')
                ):
                    failed.add(node.get("id"))
    return failed


def build(book, pages=None):
    directory = CACHE / "exports"
    directory.mkdir(parents=True, exist_ok=True)
    ident = uuid.uuid4().hex
    output = directory / (ident + ".epub")
    if book["type"] == "epub" and package_original(book, output):
        try:
            compatibility_updated = complete_package(output)
        except (ValueError, OSError):
            output.unlink(missing_ok=True)
            raise
        return {
            "id": output.name,
            "name": filename(book["title"], ".epub"),
            "fallbackPages": [],
            "fallbackObjects": 0,
            "pages": 0,
            "compatibilityUpdated": compatibility_updated,
        }
    pandoc = shutil.which("pandoc")
    if not pandoc:
        raise ValueError("导出组件不可用，请重新安装完整 App。")
    fallback, fallback_objects = [], 0
    with tempfile.TemporaryDirectory(prefix=".epub-", dir=directory) as temporary:
        work = Path(temporary)
        fragments, block_fragments = [], {}
        if book["type"] == "pdf":
            pages = pages or list(range(1, book["pages"] + 1))
            enhanced = enrichment_data(book)
            targets = {}
            for page in pages:
                for number, block in enumerate(
                    enhanced.get(str(page), {}).get("blocks", [])
                ):
                    match = REFERENCE.match(block.get("text", ""))
                    if match:
                        targets.setdefault(references(match[0])[0][0], []).append(
                            f"p{page}-b{number}"
                        )
            titles = {
                item["index"]: item["title"]
                for item in flatten_toc(book.get("toc", []))
                if item.get("index")
            }
            with (
                path_for(book["url"]).open("rb") as stream,
                open_pdf(path_for(book["url"])) as document,
            ):
                reader = PdfReader(stream)
                for page in pages:
                    title = titles.get(page, f"原书第 {page} 页")
                    fragments.append(
                        f'<h1 id="pdf-page-{page}">{html.escape(title)}</h1><p class="source-page">原 PDF 文件第 {page} 页</p>'
                    )
                    blocks = enhanced.get(str(page), {}).get("blocks", [])
                    if not blocks:
                        text = reader.pages[page - 1].extract_text() or ""
                        if text.strip():
                            fragments.extend(
                                "<p>" + html.escape(line) + "</p>"
                                for line in text.splitlines()
                                if line.strip()
                            )
                        else:
                            image_for(
                                document, page, [0, 0, 1, 1], work / f"page-{page}.png"
                            )
                            fragments.append(
                                f'<figure><img src="page-{page}.png" alt="原书第 {page} 页，尚无可重排文字"/></figure>'
                            )
                            fallback.append(page)
                        continue
                    for number, block in enumerate(blocks):
                        anchor = f"p{page}-b{number}"
                        block_fragments[anchor] = {
                            **block,
                            "page": page,
                            "fragment": len(fragments),
                        }
                        text = block.get("text", "")
                        if block["type"] == "equation":
                            fragments.append(
                                f'<div id="{anchor}" class="equation">$${html.escape(text)}$$</div>'
                            )
                        elif block["type"] == "table":
                            table = table_html(block.get("tableHtml") or "")
                            if not table:
                                table = (
                                    "<table>"
                                    + "".join(
                                        "<tr>"
                                        + "".join(
                                            "<td>" + html.escape(cell) + "</td>"
                                            for cell in row.split("\t")
                                        )
                                        + "</tr>"
                                        for row in text.splitlines()
                                    )
                                    + "</table>"
                                )
                            fragments.append(f'<div id="{anchor}">{table}</div>')
                        elif block["type"] == "image":
                            name = anchor + ".png"
                            image_for(document, page, block["bbox"], work / name)
                            fragments.append(
                                f'<figure id="{anchor}"><img src="{name}" alt="原书插图"/><figcaption>{html.escape(text)}</figcaption></figure>'
                            )
                        else:
                            tag = "h2" if block.get("headingLevel") else "p"
                            fragments.append(
                                f'<div id="{anchor}"><{tag}>{linked_text(text, targets, anchor)}</{tag}></div>'
                            )
        elif book["type"] == "txt":
            for index, chapter in enumerate(load(path_for(book["contentUrl"]), []), 1):
                fragments.append(
                    f'<h1 id="chapter-{index}">{html.escape(chapter["title"])}</h1>'
                )
                fragments.extend(
                    "<p>" + html.escape(line) + "</p>"
                    for line in chapter.get("body", "").splitlines()
                    if line.strip()
                )
        else:
            # HTML-backed imports have already passed the local-resource checks.
            for chapter in book.get("chapters", []):
                source = path_for(chapter["url"])
                root = etree.parse(str(source), etree.HTMLParser(no_network=True))
                for node in root.xpath("//script|//style|//iframe|//object|//link"):
                    node.getparent().remove(node)
                for node in root.xpath("//*[@src or @href]"):
                    for attribute in ("src", "href"):
                        value = node.get(attribute)
                        if not value:
                            continue
                        try:
                            resource = (
                                path_for(value)
                                if value.startswith("/")
                                else (source.parent / value).resolve()
                            )
                            if (
                                not resource.is_relative_to(
                                    (BOOK_ROOT / book["id"]).resolve()
                                )
                                or not resource.is_file()
                            ):
                                raise ValueError()
                            node.set(attribute, str(resource))
                        except ValueError:
                            node.attrib.pop(attribute, None)
                fragments.append(
                    "<h1>"
                    + html.escape(chapter["title"])
                    + "</h1>"
                    + etree.tostring(root, encoding="unicode", method="html")
                )
        source = work / "book.html"
        css = work / "reader.css"
        css.write_text(
            "body{font-family:serif;line-height:1.7;}h1,h2{break-after:avoid;}p{orphans:2;widows:2;}img{max-width:100%;height:auto;}figure,table{break-inside:avoid;}table{border-collapse:collapse;}td,th{border:1px solid #888;padding:.4em;}.equation{max-width:100%;overflow-x:auto;break-inside:avoid;}math[display=block]{display:block;overflow-wrap:anywhere;}.source-page{font-size:.75em;color:#666;}"
        )

        def convert():
            source.write_text(
                '<!doctype html><html><head><meta charset="utf-8"/><title>'
                + html.escape(book["title"])
                + "</title></head><body>"
                + "\n".join(fragments)
                + "</body></html>",
                encoding="utf-8",
            )
            subprocess.run(
                [
                    pandoc,
                    str(source),
                    "--from=html+tex_math_dollars"
                    if book["type"] == "pdf"
                    else "--from=html",
                    "--to=epub3",
                    "--mathml",
                    "--toc",
                    "--epub-chapter-level=1",
                    "--metadata=title:" + book["title"],
                    "--metadata=author:" + book.get("author", ""),
                    "--metadata=lang:" + book.get("language", "zh"),
                    "--css=" + str(css),
                    "--resource-path=" + str(work),
                    "-o",
                    str(work / "result.epub"),
                ],
                capture_output=True,
                timeout=240,
                check=True,
            )

        try:
            convert()
            failures = failed_math(work / "result.epub", block_fragments)
            if failures:
                with open_pdf(path_for(book["url"])) as document:
                    for anchor in failures:
                        block = block_fragments[anchor]
                        name = anchor + "-original.png"
                        image_for(document, block["page"], block["bbox"], work / name)
                        alternative = (
                            "LaTeX: " + block["text"]
                            if block["type"] == "equation"
                            else "复杂区块原图"
                        )
                        fragments[block["fragment"]] = (
                            f'<div id="{anchor}" class="original-object"><p><img src="{name}" alt="{html.escape(alternative, quote=True)}"/></p></div>'
                        )
                fallback_objects = len(failures)
                convert()
        except (OSError, subprocess.SubprocessError):
            raise ValueError(
                "EPUB 导出未完成，原书保持不变；可缩小页段后重试。"
            ) from None
        if book["type"] == "pdf":
            with zipfile.ZipFile(
                work / "result.epub", "a", zipfile.ZIP_DEFLATED
            ) as archive:
                archive.writestr(
                    "META-INF/page-between.json",
                    json.dumps(
                        {"schema": 1, "sourceHash": book["sourceHash"], "pages": pages},
                        ensure_ascii=False,
                    ),
                )
        compatibility_updated = complete_package(work / "result.epub")
        shutil.move(work / "result.epub", output)
    return {
        "id": output.name,
        "name": filename(book["title"], ".epub"),
        "fallbackPages": fallback,
        "fallbackObjects": fallback_objects,
        "pages": len(pages or []),
        "compatibilityUpdated": compatibility_updated,
    }
