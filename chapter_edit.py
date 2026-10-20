"""Manual TXT chapter edits retain offsets in the immutable normalized original."""

import copy
import tempfile
import uuid
from pathlib import Path

from book_import import (
    path_for,
    url_for,
    decode_text,
    text_metadata,
    text_toc,
)
from pdf_selection import utf16
from storage import load, save


def structure(chapters, url, manual):
    return {
        "chapters": [
            {**chapter, "body": "", "characters": utf16(chapter["body"])}
            for chapter in chapters
        ],
        "toc": text_toc(chapters),
        "contentUrl": url,
        "tocSource": "txt-manual" if manual else "txt-rules",
        "manualContents": manual,
    }


def stage(book, payload):
    if book.get("type") != "txt":
        raise ValueError("只有文字书需要手工调整章节；EPUB 沿用原书目录。")
    action = payload.get("action")
    if action not in {"rename", "split", "merge", "reset", "undo"}:
        raise ValueError("章节操作无效。")
    if not book.get("parseEnabled") and action not in {"reset", "undo"}:
        raise ValueError("请先开启章节导航，再调整目录。")
    chapters = copy.deepcopy(load(path_for(book["contentUrl"]), []))
    raw = (
        decode_text(path_for(book["originalUrl"]).read_bytes())
        .removeprefix("\ufeff")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
    )
    encoded = raw.encode("utf-16-le")
    directory = path_for(book["originalUrl"]).parent
    if directory.name != book["id"] or path_for(book["contentUrl"]).parent != directory:
        raise ValueError("文字书资源位置不一致，原文件未改动。")
    manual = True

    def part(title, start, end, volume):
        if (
            type(start) is not int
            or type(end) is not int
            or not 0 <= start <= end <= len(encoded) // 2
        ):
            raise ValueError("原文位置无效，请重新选中章节起点。")
        try:
            body = encoded[start * 2 : end * 2].decode("utf-16-le")
        except UnicodeError:
            raise ValueError("请从完整字符或段落的起点拆分章节。") from None
        leading = body[: len(body) - len(body.lstrip())]
        start += utf16(leading)
        body = body.strip()
        return {
            "title": title,
            "volume": volume,
            "body": body,
            "sourceOffset": start,
            "sourceEnd": start + utf16(body),
            "characters": utf16(body),
        }

    if action == "undo":
        previous = book.get("previousContentUrl")
        if not previous:
            raise ValueError("没有可撤销的章节调整。")
        original = path_for(previous)
        if not original.is_relative_to(directory.resolve()) or not original.is_file():
            raise ValueError("上一次目录记录不可用，原文仍保留。")
        chapters = load(original, [])
        manual = bool(book.get("previousManualContents"))
    elif action == "reset":
        with tempfile.TemporaryDirectory(
            prefix=".chapters-", dir=directory
        ) as temporary:
            text_metadata(path_for(book["originalUrl"]), Path(temporary), True)
            chapters = load(Path(temporary) / "text.json", [])
        manual = False
    else:
        index = payload.get("index")
        if type(index) is not int or not 1 <= index <= len(chapters):
            raise ValueError("章节位置无效，请重新打开目录。")
        chapter = chapters[index - 1]
        start = chapter["sourceOffset"]
        end = start + utf16(chapter["body"])
        if action in {"rename", "split"}:
            title = payload.get("title")
            if not isinstance(title, str) or not title.strip() or len(title) > 120:
                raise ValueError("请填写不超过 120 字的章节标题。")
            title = " ".join(title.split())
        if action == "rename":
            chapter["title"] = title
        elif action == "split":
            offset = payload.get("offset")
            if type(offset) is not int or not start <= offset < end:
                raise ValueError("请在当前章节内选中一个有效起点。")
            if offset == start:
                chapter["title"] = title
            else:
                chapters[index - 1 : index] = [
                    part(chapter["title"], start, offset, chapter.get("volume", "")),
                    part(title, offset, end, chapter.get("volume", "")),
                ]
        elif action == "merge":
            if index == 1:
                raise ValueError("第一章之前没有可以合并的章节。")
            previous = chapters[index - 2]
            chapters[index - 2 : index] = [
                part(
                    previous["title"],
                    previous["sourceOffset"],
                    end,
                    previous.get("volume", ""),
                )
            ]
    target = directory / ("text-" + uuid.uuid4().hex + ".json")
    save(target, chapters)
    url = url_for(target)
    return {
        **structure(chapters, url, manual),
        "parseEnabled": True,
        "processing": "ready",
        "processingNote": "手工目录已保存，可撤销最近一次调整。"
        if manual
        else "已恢复自动章节索引。",
        "previousContentUrl": book["contentUrl"],
        "previousManualContents": bool(book.get("manualContents")),
        "customContentsUrl": url if manual else None,
        "structureRevision": uuid.uuid4().hex,
    }


def cleanup(book):
    keep = {
        path_for(url).resolve()
        for url in [
            book.get("contentUrl"),
            book.get("previousContentUrl"),
            book.get("customContentsUrl"),
            book.get("lastRenderedContentUrl"),
        ]
        if url
    }
    directory = path_for(book["contentUrl"]).parent
    if directory.name != book["id"]:
        raise ValueError("文字书资源位置不一致。")
    for path in directory.glob("text-*.json"):
        if path.resolve() not in keep:
            path.unlink(missing_ok=True)
