"""Explicitly saved excerpts with source anchors, independent of transient selections."""
import copy
import json
import math
import re
import threading
import time
import uuid
import zipfile

import ai_tutor
import book_images
from book_import import BOOK_ROOT, position_label, flatten_toc
from paths import CACHE
from storage import load, save

LOCK = threading.RLock()
MAX_EXPORT = 200 * 1024**2


def records(book, root=None):
    path = (root or BOOK_ROOT) / book["id"] / "margins.json"
    data = load(path, {"items": []})
    if not isinstance(data, dict) or not isinstance(data.get("items"), list) or len(data["items"]) > 10000:
        raise ValueError("页边记录无法读取。")
    return data


def validate(book, root):
    from library_data import validate_position
    data = records(book, root)
    seen = set()
    for item in data["items"]:
        if (not isinstance(item, dict) or not re.fullmatch(r"[0-9a-f]{32}", str(item.get("id", "")))
                or item["id"] in seen or not isinstance(item.get("note", ""), str) or len(item.get("note", "")) > 2000
                or type(item.get("createdAt")) not in {int, float} or not math.isfinite(item["createdAt"])):
            raise ValueError("页边记录格式无效。")
        seen.add(item["id"])
        source = item.get("source")
        ai_tutor.source_for(book, source, resource_root=root)
        validate_position(source["position"], book)
        for name in ("translation", "answer"):
            if not isinstance(item.get(name, ""), str) or len(item.get(name, "")) > 100000:
                raise ValueError("页边关联内容无效。")
    return data


def change(book, payload):
    operation, ident = payload.get("operation"), payload.get("id")
    if not isinstance(ident, str) or not re.fullmatch(r"[0-9a-f]{32}", ident):
        raise ValueError("页边记录标识无效。")
    with LOCK:
        data = records(book)
        item = next((item for item in data["items"] if item["id"] == ident), None)
        if operation == "save":
            if item:
                return copy.deepcopy(item)
            if len(data["items"]) >= 10000:
                raise ValueError("本书页边记录已达上限，请先导出整理。")
            source = ai_tutor.source_for(book, payload.get("source"))
            original = payload["source"].get("quote", "")
            if original.strip():
                source["quote"] = original
            # Nearby context is for answering questions, not part of a saved excerpt.
            source = {key: source[key] for key in ("quote", "position", "citation", "image") if key in source}
            kind = payload["source"].get("kind")
            source["kind"] = kind if isinstance(kind, str) and kind in {"text", "table", "equation", "image"} else "text"
            item = {"id": ident, "source": source, "createdAt": time.time(), "note": ""}
            related = payload.get("related")
            if related:
                if not isinstance(related, dict):
                    raise ValueError("关联记录无效。")
                if related.get("type") == "ai":
                    conversation = ai_tutor.conversation(related.get("id"), book["id"])
                    item["answer"] = "\n\n".join(message["content"] for message in conversation["messages"] if message.get("role") == "assistant" and message.get("status") != "generating")
                elif related.get("type") == "translation":
                    import translation
                    with translation.LOCK:
                        translated = next((value for value in translation.records(book)["items"] if value["id"] == related.get("id")), None)
                        if translated is None:
                            translated = next((job["result"] for job in translation.JOBS.values() if job["book"] == book["id"] and job.get("result", {}).get("id") == related.get("id")), None)
                        if translated is None:
                            raise ValueError("这次翻译已关闭，请重新翻译后保存。")
                        item["translation"] = translated["translation"]
                else:
                    raise ValueError("关联记录无效。")
                item["related"] = related
            existing = next((previous for previous in data["items"] if not previous.get("deletedAt") and previous["source"] == item["source"] and previous.get("answer") == item.get("answer") and previous.get("translation") == item.get("translation")), None)
            if existing:
                return copy.deepcopy(existing)
            data["items"].insert(0, item)
        elif item is None:
            raise ValueError("找不到这条页边记录。")
        elif operation == "note":
            note = payload.get("note", "")
            if not isinstance(note, str) or len(note) > 2000:
                raise ValueError("笔记请控制在 2000 字以内。")
            item["note"] = note
        elif operation == "remove":
            item["deletedAt"] = time.time()
        elif operation == "restore":
            item.pop("deletedAt", None)
        else:
            raise ValueError("页边操作无效。")
        save(BOOK_ROOT / book["id"] / "margins.json", data)
        return copy.deepcopy(item)


def chapter_for(book, position):
    page, y = position["index"], position.get("pdfY", 0)
    if book["type"] == "pdf":
        entries = [entry for entry in flatten_toc(book.get("toc", []))
                   if type(entry.get("index")) is int and (entry["index"], entry.get("pdfY", 0)) <= (page, y)]
        if entries:
            return max(entries, key=lambda entry: (entry["index"], entry.get("pdfY", 0)))["title"]
    if book["type"] in {"txt", "epub"} and 1 <= page <= len(book.get("chapters", [])):
        return book["chapters"][page - 1]["title"]
    return position_label(book, position)


def listing(book):
    with LOCK:
        return [{**copy.deepcopy(item), "chapter": chapter_for(book, item["source"]["position"])} for item in records(book)["items"] if not item.get("deletedAt")]


def preview(book, item):
    source = item["source"]
    import translation
    return translation.preview(book, source, source["quote"])


def export(book, state, format):
    if format not in {"json", "markdown"}:
        raise ValueError("请选择 JSON 或 Markdown。")
    import translation
    data = {"schema": 1, "book": {key: book.get(key) for key in ("id", "title", "author")},
            "excerpts": listing(book), "bookmarks": [mark for mark in state.get("bookmarks", []) if mark.get("book") == book["id"]],
            "translations": translation.records(book)["items"],
            "conversations": [item for item in ai_tutor.records()["conversations"] if item["book"] == book["id"]]}
    data = copy.deepcopy(data)
    size = len(json.dumps(data, ensure_ascii=False).encode())
    if size > MAX_EXPORT:
        raise ValueError("本书记录超过 200 MB，请减少导出记录或单独保存原图。")
    directory = CACHE / "exports"
    directory.mkdir(parents=True, exist_ok=True)
    name = uuid.uuid4().hex + (".json" if format == "json" else ".zip")
    path = directory / (name.split(".")[0] + ".part")
    try:
        if format == "json":
            def embed(value):
                nonlocal size
                if isinstance(value, dict):
                    for key, item in value.items():
                        if key == "image" and isinstance(item, str):
                            value[key] = book_images.image_part(book, item)["image_url"]["url"]
                            size += len(value[key])
                            if size > MAX_EXPORT:
                                raise ValueError("JSON 原图较多，请改用 Markdown 文件包。")
                        else:
                            embed(item)
                elif isinstance(value, list):
                    for item in value: embed(item)
            embed(data)
            save(path, data)
        else:
            lines = ["# " + book["title"], ""]
            with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
                images = set()
                for item in data["excerpts"]:
                    source = item["source"]
                    lines += ["## " + position_label(book, source["position"]), "", source["quote"], ""]
                    if source.get("image"):
                        body, mime = book_images.stored_image(book, source["image"])
                        image = "images/" + source["image"].rsplit("/", 1)[-1]
                        if image not in images:
                            size += len(body)
                            if size > MAX_EXPORT:
                                raise ValueError("本书记录超过 200 MB，请减少导出记录或单独保存原图。")
                            archive.writestr(image, body)
                            images.add(image)
                        lines += [f"![原图]({image})", ""]
                    for key, title in (("note", "笔记"), ("translation", "译文"), ("answer", "答疑")):
                        if item.get(key): lines += ["### " + title, "", item[key], ""]
                for title, items, text in (("书签", data["bookmarks"], lambda item: item.get("label", "")),
                                            ("翻译收藏", data["translations"], lambda item: item["text"] + "\n\n" + item["translation"]),
                                            ("答疑记录", data["conversations"], lambda item: item["source"]["quote"] + "\n\n" + "\n\n".join(message.get("content", "") for message in item["messages"]))):
                    if items:
                        lines += ["## " + title, ""]
                        for item in items:
                            lines += [item.get("source", {}).get("citation", ""), "", text(item), ""]
                archive.writestr("页边.md", "\n".join(lines))
        path.replace(directory / name)
    finally:
        path.unlink(missing_ok=True)
    return {"download": "/api/downloads/" + name, "name": "页边" + (".json" if format == "json" else ".zip")}
