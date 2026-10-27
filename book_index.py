"""Rebuildable, book-local search and numbered-reference index."""

import collections
import hashlib
import json
import math
import re
import sqlite3
import threading
import unicodedata
from contextlib import closing

from lxml import etree
from pypdf import PdfReader

from book_import import path_for, XML, text_chapter_index, flatten_toc, position_label
from paths import CACHE
from pdf_enhancement import (
    enrichment_data,
    prepared_pages,
    saved_selection,
    selection_directory,
)
from pdf_selection import utf16
from storage import load

LOCKS = collections.defaultdict(threading.Lock)
NAMES = {
    "theorem": "theorem",
    "定理": "theorem",
    "lemma": "lemma",
    "引理": "lemma",
    "proposition": "proposition",
    "命题": "proposition",
    "corollary": "corollary",
    "推论": "corollary",
    "definition": "definition",
    "定义": "definition",
    "example": "example",
    "例题": "example",
    "例": "example",
    "exercise": "exercise",
    "习题": "exercise",
    "equation": "equation",
    "公式": "equation",
    "方程": "equation",
}
REFERENCE = re.compile(
    r"(?<![A-Za-z])("
    + "|".join(NAMES)
    + r")\s*([A-Za-z]?\d+(?:[.\-]\d+)*[a-z]?)(?!\d|[.\-]\d)",
    re.I,
)


def references(text):
    return [
        (NAMES[match[1].casefold()] + ":" + match[2].casefold(), match[0])
        for match in REFERENCE.finditer(unicodedata.normalize("NFKC", text))
    ]


def tokens(text, *, unigrams=False):
    text = unicodedata.normalize("NFKC", text).casefold()
    words = re.findall(r"[a-z0-9_]+", text)
    for run in re.findall(r"[\u3400-\u9fff]+", text):
        words.extend(run[index : index + 2] for index in range(max(1, len(run) - 1)))
        if unigrams and len(run) > 1:
            words.extend(run)
    return words


def fingerprint(book):
    files = []
    if book["type"] == "pdf" and book.get("parseEnabled"):
        folder = selection_directory(book)
        for page in prepared_pages(book):
            stat = (folder / f"{page}.json").stat()
            files.append(
                (folder.name, page, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
            )
    return hashlib.sha256(
        json.dumps(
            [
                9,
                book.get("sourceHash"),
                book.get("enhancementRevision"),
                book.get("enrichmentUrl"),
                book.get("parseEnabled"),
                book.get("chapters"),
                book.get("toc") if book.get("type") == "epub" else None,
                files,
            ],
            sort_keys=True,
            ensure_ascii=False,
        ).encode()
    ).hexdigest()


def paragraphs(text):
    cursor = 0
    for paragraph in re.split(r"\n\s*\n|\n", text):
        start = text.find(paragraph, cursor)
        cursor = start + len(paragraph)
        if paragraph.strip():
            yield paragraph.strip(), start + len(paragraph) - len(paragraph.lstrip())


def leading_section(node, section, markers):
    for event, element in etree.iterwalk(node, events=("start", "end")):
        if event == "start":
            for marker in (element.get("id"), element.get("name")):
                if marker in markers:
                    section = marker
            if (element.text or "").strip():
                break
        elif element is not node and (element.tail or "").strip():
            break
    return section


def text_units(book):
    if book["type"] == "txt":
        chapters = load(path_for(book["contentUrl"]), [])
        for index, chapter in enumerate(chapters, 1):
            body = chapter.get("body", "")
            for number, (text, offset) in enumerate(paragraphs(body)):
                position = {
                    "index": index,
                    "sourceOffset": chapter.get("sourceOffset", 0)
                    + utf16(body[:offset]),
                    "anchor": {
                        "index": number,
                        "quote": text[:60],
                        "charOffset": 0,
                        "pixels": 0,
                    },
                }
                yield index, number, text, position, "text"
    elif book["type"] == "epub":
        names = {"p", "h1", "h2", "h3", "h4", "blockquote", "figure", "table"}
        sections = collections.defaultdict(set)
        for item in flatten_toc(book.get("toc", [])):
            if item.get("index") and item.get("fragment"):
                sections[item["index"]].add(item["fragment"])
        for index, chapter in enumerate(book["chapters"], 1):
            root = etree.parse(str(path_for(chapter["url"])), XML)
            body = root.xpath('//*[local-name()="body"]')
            if not body:
                continue
            number, section = 0, ""
            for node in body[0].iter():
                if not isinstance(node.tag, str) or (
                    etree.QName(node).localname in {"nav", "script", "style"}
                    or any(
                        etree.QName(parent).localname in {"nav", "script", "style"}
                        for parent in node.iterancestors()
                        if isinstance(parent.tag, str)
                    )
                ):
                    continue
                for marker in (node.get("id"), node.get("name")):
                    if marker in sections[index]:
                        section = marker
                if etree.QName(node).localname not in names:
                    continue
                anchor_number = number
                number += 1
                if any(
                    etree.QName(child).localname in names
                    for child in node.iterdescendants()
                    if isinstance(child.tag, str)
                ):
                    continue
                text = " ".join("".join(node.itertext()).split())
                if not text:
                    continue
                section = leading_section(node, section, sections[index])
                position = {
                    "index": index,
                    "fragment": section,
                    "anchor": {
                        "index": anchor_number,
                        "sourceNode": anchor_number,
                        "quote": text[:60],
                        "charOffset": 0,
                        "pixels": 0,
                    },
                }
                yield index, anchor_number, text, position, "text"
    elif book["type"] == "pdf":
        enhanced = enrichment_data(book)
        with path_for(book["url"]).open("rb") as stream:
            document = PdfReader(stream)
            for index in range(1, book["pages"] + 1):
                blocks = enhanced.get(str(index), {}).get("blocks", [])
                if blocks:
                    for number, block in enumerate(blocks):
                        if block.get("text"):
                            y = block.get("bbox", [0, 0, 1, 1])[1]
                            yield (
                                index,
                                int(y * 100000),
                                block["text"],
                                {"index": index, "pdfY": y, "blockOrder": number},
                                block.get("type", "text"),
                            )
                    continue
                text = document.pages[index - 1].extract_text() or ""
                if text.strip():
                    for number, (paragraph, _) in enumerate(paragraphs(text)):
                        yield index, 0, paragraph, {"index": index, "pdfY": 0}, "text"
                    continue
                if not book.get("parseEnabled"):
                    continue
                data = saved_selection(book, index) or {}
                for line in data.get("lines", []):
                    y = line.get("bbox", [0, 0, 1, 1])[1]
                    if line.get("text"):
                        yield (
                            index,
                            int(y * 100000),
                            line["text"],
                            {"index": index, "pdfY": y},
                            "text",
                        )


def connection(book):
    directory = CACHE / "book-index-v2"
    directory.mkdir(parents=True, exist_ok=True)
    database = sqlite3.connect(directory / (book["id"] + ".sqlite"), timeout=60)
    database.row_factory = sqlite3.Row
    return database


def ensure(book):
    stamp = fingerprint(book)
    with LOCKS[book["id"]], closing(connection(book)) as db:
        db.execute(
            "CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY, stamp TEXT, status TEXT)"
        )
        previous = db.execute("SELECT stamp,status FROM metadata WHERE id=1").fetchone()
        if previous and previous["stamp"] == stamp:
            return json.loads(previous["status"])
        with db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, idx INTEGER, ordinal INTEGER, text TEXT, position TEXT, kind TEXT, label TEXT, label_key TEXT, source_offset INTEGER, source_end INTEGER)"
            )
            db.execute(
                "CREATE INDEX IF NOT EXISTS reference_labels ON chunks(label_key)"
            )
            db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS fulltext USING fts5(terms)")
            db.execute("DELETE FROM chunks")
            db.execute("DELETE FROM fulltext")
            covered, count = set(), 0
            for index, ordinal, text, position, kind in text_units(book):
                covered.add(index)
                for offset in range(0, len(text), 1800):
                    part = text[offset : offset + 1800]
                    first = REFERENCE.match(part.strip())
                    label = first[0] if first else ""
                    key = references(label)[0][0] if label else ""
                    if kind == "equation":
                        tag = re.search(r"\\tag\{([^}]+)\}", part)
                        if tag:
                            label, key = (
                                "公式 " + tag[1],
                                "equation:" + tag[1].casefold(),
                            )
                    source = dict(position)
                    if offset and "anchor" in source:
                        source["anchor"] = {
                            **source["anchor"],
                            "charOffset": utf16(text[:offset]),
                        }
                    if "sourceOffset" in source:
                        source["sourceOffset"] += utf16(text[:offset])
                    source_offset = source.get("sourceOffset")
                    row = db.execute(
                        "INSERT INTO chunks(idx,ordinal,text,position,kind,label,label_key,source_offset,source_end) VALUES(?,?,?,?,?,?,?,?,?)",
                        (
                            index,
                            ordinal,
                            part,
                            json.dumps(source, ensure_ascii=False),
                            kind,
                            label,
                            key,
                            source_offset,
                            source_offset + utf16(part)
                            if source_offset is not None
                            else None,
                        ),
                    )
                    db.execute(
                        "INSERT INTO fulltext(rowid,terms) VALUES(?,?)",
                        (row.lastrowid, " ".join(tokens(part, unigrams=True))),
                    )
                    count += 1
            total = book.get("pages", len(book.get("chapters", [])))
            status = {
                "covered": len(covered),
                "total": total,
                "chunks": count,
                "partial": len(covered) < total,
                "unit": "页" if book["type"] == "pdf" else "章",
            }
            db.execute(
                "INSERT OR REPLACE INTO metadata(id,stamp,status) VALUES(1,?,?)",
                (stamp, json.dumps(status)),
            )
        return status


def snapshot(book, row):
    position = json.loads(row["position"])
    chapter = position_label(book, position)
    return {
        "id": row["id"],
        "text": row["text"],
        "kind": row["kind"],
        "label": row["label"],
        "position": position,
        "citation": f"《{book['title']}》 · {chapter}",
    }


def search(book, query="", *, position=None, previous_only=False, limit=20):
    if not isinstance(query, str) or len(query) > 6000:
        raise ValueError("检索文字过长。")
    clause, parameters = "1=1", []
    if previous_only:
        if (
            book["type"] == "txt"
            and isinstance(position, dict)
            and "sourceOffset" in position
        ):
            position = {
                **position,
                "index": text_chapter_index(book, position["sourceOffset"]),
            }
        total = book.get("pages", len(book.get("chapters", [])))
        if (
            not isinstance(position, dict)
            or type(position.get("index")) is not int
            or not 1 <= position["index"] <= total
        ):
            raise ValueError("请先提供当前阅读位置。")
        anchor = position.get("anchor", {})
        if anchor is None:
            anchor = {}
        y = position.get("pdfY", 0)
        if (
            not isinstance(anchor, dict)
            or type(anchor.get("index", 0)) is not int
            or anchor.get("index", 0) < 0
            or type(y) not in {int, float}
            or not math.isfinite(y)
            or not 0 <= y <= 1
        ):
            raise ValueError("阅读位置无效。")
        ordinal = (
            int(y * 100000)
            if book["type"] == "pdf"
            else anchor.get("sourceNode", anchor.get("index", 0))
        )
        if type(ordinal) is not int or ordinal < 0:
            raise ValueError("原文锚点无效。")
        clause = "(idx<? OR (idx=? AND ordinal<?))"
        parameters = [position["index"], position["index"], ordinal]
        if book["type"] == "pdf":
            order = position.get("blockOrder", -1)
            if type(order) is not int or not -1 <= order <= 5000:
                raise ValueError("原文区块位置无效。")
            # A page coordinate alone cannot establish reading order across columns.
            clause = "(idx<? OR (idx=? AND json_extract(position,'$.blockOrder')<?))"
            parameters = [position["index"], position["index"], order]
        if book["type"] == "txt" and "sourceOffset" in position:
            offset = position["sourceOffset"]
            if type(offset) is not int or not 0 <= offset <= 1000000000:
                raise ValueError("原文字符位置无效。")
            clause, parameters = "source_end<=?", [offset]
    status = ensure(book)
    with closing(connection(book)) as db:
        candidates = []
        for key, _ in references(query):
            candidates.extend(
                db.execute(
                    "SELECT * FROM chunks WHERE label_key=? AND "
                    + clause
                    + " ORDER BY idx,ordinal LIMIT ?",
                    [key, *parameters, limit],
                ).fetchall()
            )
        terms = list(dict.fromkeys(tokens(query)))[:48]
        if terms:
            expression = " OR ".join('"' + term + '"' for term in terms)
            candidates.extend(
                db.execute(
                    "SELECT c.* FROM fulltext f JOIN chunks c ON c.id=f.rowid WHERE fulltext MATCH ? AND "
                    + clause
                    + " ORDER BY bm25(fulltext) LIMIT ?",
                    [expression, *parameters, limit * 3],
                ).fetchall()
            )
        elif not query.strip():
            candidates.extend(
                db.execute(
                    "SELECT * FROM chunks WHERE label!='' AND "
                    + clause
                    + " ORDER BY idx,ordinal LIMIT ?",
                    [*parameters, limit],
                ).fetchall()
            )
        seen, result = set(), []
        for row in candidates:
            if row["id"] not in seen:
                seen.add(row["id"])
                result.append(snapshot(book, row))
                if len(result) == limit:
                    break
    return {"status": status, "results": result}
