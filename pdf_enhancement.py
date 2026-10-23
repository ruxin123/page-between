"""One OCR/TOC pipeline for every PDF; no textbook-specific page tables."""

import collections
import json
import re
import subprocess
import threading
import statistics
import io
import shutil
import hashlib
import math
import xml.etree.ElementTree as ET
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path

from book_import import ROOT, path_for

from paths import CACHE as CACHE_ROOT, RUNTIME
from storage import save

OCR = RUNTIME / "ocr-page"
CACHE = CACHE_ROOT / "ocr-v4"
LOCKS = collections.defaultdict(threading.Lock)
PDF_LOCK = threading.RLock()
OCR_SLOTS = threading.BoundedSemaphore(2)


@contextmanager
def open_pdf(path):
    import pypdfium2 as pdfium

    with PDF_LOCK:
        document = pdfium.PdfDocument(str(path))
    try:
        yield document
    finally:
        with PDF_LOCK:
            document.close()


def source_path(book):
    return path_for(book["url"])


@lru_cache(maxsize=64)
def document_hash(path, size, modified, changed):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def source_digest(book):
    source = source_path(book)
    stat = source.stat()
    return document_hash(
        str(source.resolve()), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns
    )


def selection_directory(book):
    source = source_path(book)
    identity = {
        "source": source_digest(book),
        "language": book.get("language", "en"),
        "recognition": "character-boxes-v4",
    }
    fingerprint = hashlib.sha256(
        json.dumps(identity, sort_keys=True).encode()
    ).hexdigest()[:24]
    return source.parent / "selection-text-v1" / fingerprint


def save_selection(book, page, data):
    folder = selection_directory(book)
    if (
        not isinstance(data, dict)
        or data.get("page") != page
        or not isinstance(data.get("lines"), list)
        or any(
            not isinstance(data.get(key), (int, float))
            or not math.isfinite(data[key])
            or data[key] <= 0
            for key in ("width", "height")
        )
    ):
        raise ValueError("本页文字识别结果不完整，请重试。")
    data = {**data, "selectionFingerprint": folder.name}
    save(folder / f"{page}.json", data)
    return data


def saved_selection(book, page):
    folder = selection_directory(book)
    path = folder / f"{page}.json"
    try:
        data = json.loads(path.read_text())
        if (
            data.get("selectionFingerprint") == folder.name
            and data.get("page") == page
            and isinstance(data.get("lines"), list)
        ):
            return data
    except (OSError, ValueError, AttributeError):
        pass
    english = not book.get("language", "en").startswith("zh")
    legacy = CACHE / book["id"] / f"{page}-full{'-eng' if english else ''}.json"
    try:
        data = json.loads(legacy.read_text())
        if (
            legacy.stat().st_mtime_ns >= source_path(book).stat().st_mtime_ns
            and data.get("page") == page
            and isinstance(data.get("lines"), list)
            and data.get("engine") == ("tesseract-eng" if english else "apple-vision")
        ):
            return save_selection(book, page, data)
    except (OSError, ValueError, AttributeError):
        pass
    return None


@lru_cache(maxsize=4096)
def valid_saved_selection(path, size, modified, changed, fingerprint, page):
    try:
        data = json.loads(Path(path).read_text())
        return (
            data.get("selectionFingerprint") == fingerprint
            and data.get("page") == page
            and isinstance(data.get("lines"), list)
        )
    except (OSError, ValueError, AttributeError):
        return False


def prepared_pages(book):
    folder = selection_directory(book)
    if not (folder / "legacy-migrated.json").exists():
        for path in (CACHE / book["id"]).glob("*-full*.json"):
            number = path.name.split("-", 1)[0]
            if number.isdigit() and 1 <= int(number) <= book["pages"]:
                saved_selection(book, int(number))
        save(folder / "legacy-migrated.json", {"complete": True})
    result = []
    for path in folder.glob("*.json"):
        if not path.stem.isdigit() or not 1 <= int(path.stem) <= book["pages"]:
            continue
        stat = path.stat()
        if valid_saved_selection(
            str(path),
            stat.st_size,
            stat.st_mtime_ns,
            stat.st_ctime_ns,
            folder.name,
            int(path.stem),
        ):
            result.append(int(path.stem))
    return sorted(result)


def enrichment_data(book):
    if not book.get("parseEnabled") or not book.get("enrichmentUrl"):
        return {}
    path = (
        ROOT / book["enrichmentUrl"].lstrip("/")
        if book["enrichmentUrl"].startswith("/assets/")
        else path_for(book["enrichmentUrl"])
    )
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def page_enrichment(book, page):
    return enrichment_data(book).get(str(page), {}).get("blocks", [])


def apply_enrichment(data, book, page, mode):
    if mode != "full":
        return data
    data["blocks"] = page_enrichment(book, page)
    return data


def hocr_lines(source, width, height):
    """Keep the OCR engine's individual glyph boxes instead of stretching a word."""
    root = ET.fromstring(source)

    def has_class(element, name):
        return name in element.get("class", "").split()

    def bounds(element, field="bbox"):
        match = re.search(
            r"(?:^|;\s*)" + field + r"\s+(\d+) (\d+) (\d+) (\d+)",
            element.get("title", ""),
        )
        if not match:
            raise ValueError("文字识别结果缺少字符坐标。")
        left, top, right, bottom = map(int, match.groups())
        return [left / width, top / height, right / width, bottom / height]

    lines = []
    for line in root.iter():
        if not has_class(line, "ocr_line"):
            continue
        segments = []
        for word in line.iter():
            if not has_class(word, "ocrx_word"):
                continue
            glyphs = [node for node in word.iter() if has_class(node, "ocrx_cinfo")]
            if glyphs:
                for glyph in glyphs:
                    value = "".join(glyph.itertext())
                    if value:
                        segments.append(
                            {"text": value, "bbox": bounds(glyph, "x_bboxes")}
                        )
            else:
                value = "".join(word.itertext()).strip()
                if value:
                    segments.append({"text": value, "bbox": bounds(word)})
            if segments:
                segments[-1]["text"] += " "
        if segments:
            lines.append(
                {
                    "text": "".join(item["text"] for item in segments).strip(),
                    "bbox": bounds(line),
                    "segments": segments,
                    "confidence": 1,
                }
            )
    return lines


def recognize(book, page, mode="full", *, allow_native=False, include_enrichment=True):
    if type(page) is not int or not 1 <= page <= book["pages"]:
        raise ValueError("页码超出了书籍范围。")
    key = (str(selection_directory(book)), page, mode)
    english = not book.get("language", "en").startswith("zh") and mode != "fast"
    path = CACHE / book["id"] / f"{page}-{mode}{'-eng' if english else ''}.json"
    with LOCKS[key]:
        if mode == "full":
            data = saved_selection(book, page)
            if data and (allow_native or not data.get("native")):
                return (
                    apply_enrichment(data, book, page, mode)
                    if include_enrichment
                    else data
                )
        elif path.is_file():
            return apply_enrichment(json.loads(path.read_text()), book, page, mode)
        with OCR_SLOTS:
            if allow_native and mode == "full":
                with open_pdf(source_path(book)) as document, PDF_LOCK:
                    original = document[page - 1]
                    try:
                        text = original.get_textpage()
                        try:
                            native_text = text.get_text_range().strip()
                        finally:
                            text.close()
                        size = [original.get_width(), original.get_height()]
                    finally:
                        original.close()
                if native_text:
                    data = save_selection(
                        book,
                        page,
                        {
                            "page": page,
                            "width": size[0],
                            "height": size[1],
                            "native": True,
                            "engine": "pdf-native",
                            "lines": [],
                        },
                    )
                    return (
                        apply_enrichment(data, book, page, mode)
                        if include_enrichment
                        else data
                    )
            data = recognize_page(book, page, mode, english)
        if mode == "full":
            data = save_selection(book, page, data)
        else:
            save(path, data)
        return apply_enrichment(data, book, page, mode) if include_enrichment else data


def recognize_page(book, page, mode, english):
    if english:
        with open_pdf(source_path(book)) as document, PDF_LOCK:
            original = document[page - 1]
            try:
                bitmap = original.render(scale=1900 / original.get_width())
                try:
                    image = bitmap.to_pil().copy()
                finally:
                    bitmap.close()
            finally:
                original.close()
        stream = io.BytesIO()
        image.save(stream, format="PNG")
        tesseract = shutil.which("tesseract")
        if not tesseract:
            raise ValueError("英文扫描页需要先安装 Tesseract。")
        result = subprocess.run(
            [
                tesseract,
                "stdin",
                "stdout",
                "-l",
                "eng",
                "--psm",
                "3",
                "-c",
                "tessedit_create_hocr=1",
                "-c",
                "hocr_char_boxes=1",
            ],
            input=stream.getvalue(),
            capture_output=True,
            timeout=120,
        )
        if result.returncode:
            raise ValueError("本页文字识别失败，请重试。")
        width, height = image.size
        lines = hocr_lines(result.stdout, width, height)
        data = {
            "page": page,
            "width": width,
            "height": height,
            "engine": "tesseract-eng",
            "lines": lines,
        }
    else:
        command = [str(OCR), str(source_path(book)), str(page)]
        if mode != "full":
            command.append("--" + mode)
        result = subprocess.run(command, capture_output=True, text=True, timeout=180)
        if result.returncode:
            raise ValueError("本页文字识别失败，可重试或继续阅读原页。")
        data = json.loads(result.stdout)
    return data


def joined_rows(lines):
    rows = []
    # Printed page numbers near the centre distinguish two TOC columns from long one-column titles.
    middle_numbers = [
        line["bbox"][2]
        for line in lines
        if 0.40 < line["bbox"][2] < 0.55
        and re.fullmatch(r"\d{1,4}", line["text"].strip())
    ]
    two_columns = len(middle_numbers) >= 5
    boundary = statistics.median(middle_numbers) + 0.01 if two_columns else 1
    for line in sorted(
        lines,
        key=lambda line: ((line["bbox"][1] + line["bbox"][3]) / 2, line["bbox"][0]),
    ):
        center = (line["bbox"][1] + line["bbox"][3]) / 2
        column = 1 if two_columns and line["bbox"][0] > boundary else 0
        height = line["bbox"][3] - line["bbox"][1]
        row = next(
            (
                row
                for row in reversed(rows[-5:])
                if row["column"] == column
                and min(row["bottom"], line["bbox"][3])
                - max(row["top"], line["bbox"][1])
                > min(row["bottom"] - row["top"], height) * 0.45
            ),
            None,
        )
        if row is None:
            row = {
                "center": center,
                "column": column,
                "parts": [],
                "top": line["bbox"][1],
                "bottom": line["bbox"][3],
            }
            rows.append(row)
        row["parts"].append(line)
        row["top"] = min(row["top"], line["bbox"][1])
        row["bottom"] = max(row["bottom"], line["bbox"][3])
    return [
        {
            "text": " ".join(
                part["text"]
                for part in sorted(row["parts"], key=lambda part: part["bbox"][0])
            ),
            "column": row["column"],
            "bbox": [
                min(p["bbox"][0] for p in row["parts"]),
                min(p["bbox"][1] for p in row["parts"]),
                max(p["bbox"][2] for p in row["parts"]),
                max(p["bbox"][3] for p in row["parts"]),
            ],
        }
        for row in sorted(rows, key=lambda row: (row["column"], row["center"]))
    ]


def toc_entries(lines):
    entries = []
    pending = None
    for row in joined_rows(lines):
        text = row["text"].strip()
        if re.search(r"contents|目\s*录", text, re.I) and row["bbox"][1] < 0.2:
            pending = None
            continue
        match = re.match(r"^(.*?)\s*(\d{1,4})\s*$", text)
        if not match:
            if re.match(
                r"^第[一二三四五六七八九十]+部分$", text.replace(" ", "")
            ) or re.search(r"\s+[ivxlcdm]{1,8}$", text, re.I):
                pending = None
            elif len(text) > 3 and re.search(r"[A-Za-z\u3400-\u9fff]", text):
                pending = row
            continue
        title = re.sub(r"[\s.·•…_—\-．~・]+$", "", match[1]).strip()
        printed = int(match[2])
        if len(title) < 2 or not 0 < printed < 10000:
            continue
        if not re.search(r"[A-Za-z\u3400-\u9fff]", title):
            continue
        if (
            pending
            and pending["column"] == row["column"]
            and 0 < row["bbox"][1] - pending["bbox"][1] < 0.04
        ):
            title = pending["text"] + " " + title
        pending = None
        title = re.sub(r"^[§$]\s*", "", title)
        title = re.split(r"\.{2,}|[·•…_．]{3,}", title, maxsplit=1)[0].strip()
        title = re.sub(r"(?:\.\s*\d+)+\.?$", "", title).rstrip(" .")
        title = re.sub(r"\s+", " ", title)
        level = (
            0
            if re.match(
                r"^(?:第\s*[\d一二三四五六七八九十百IVX]+\s*[章部篇]|Chapter\b|[IVXLCDM]+(?:\s|[.:·—])|Introduction|Appendix|索引|附录|Index|Bibliography)",
                title,
                re.I,
            )
            else 1
        )
        entries.append({"title": title, "printed": printed, "level": level})
    return entries


def is_contents(lines):
    title = any(
        re.search(
            r"^(?:table of contents|contents|目\s*录)$", line["text"].strip(), re.I
        )
        and line["bbox"][1] < 0.35
        for line in lines
    )
    leaders = sum(bool(re.search(r"[.·•…_．]{3,}", line["text"])) for line in lines)
    return title or leaders >= 7


def printed_number(lines):
    choices = []
    for line in lines:
        x0, y0, x1, y1 = line["bbox"]
        if not (y0 < 0.09 or y1 > 0.91):
            continue
        text = line["text"].strip()
        if re.fullmatch(r"\d{1,4}", text):
            choices.append((3, int(text)))
        else:
            start = re.match(r"^(\d{1,4})(?:\s|第|[A-Za-z])", text)
            end = re.search(r"(?:\s|[A-Za-z])\s*(\d{1,4})$", text)
            if start and x0 < 0.2:
                choices.append((2, int(start[1])))
            if end and x1 > 0.8:
                choices.append((2, int(end[1])))
    return max(choices, default=(0, None))[1]


def tree_from_entries(entries):
    root, stack = [], []
    for entry in entries:
        item = {**entry, "children": [], "fragment": ""}
        level = item.pop("level", 0)
        while stack and stack[-1][0] >= level:
            stack.pop()
        (stack[-1][1]["children"] if stack else root).append(item)
        stack.append((level, item))
    return root


def build_contents(book, progress=lambda phase: None):
    if book.get("tocSource") == "pdf-outline":
        return {"toc": book["toc"], "tocSource": "pdf-outline", "processing": "ready"}
    found, end, entries = None, None, []
    for page in range(1, min(book["pages"], 48) + 1):
        progress(f"查找原书目录 · {page} / {min(book['pages'], 48)}")
        fast = recognize(book, page, "fast")
        if not is_contents(fast["lines"]):
            continue
        accurate = recognize(book, page, "layout")
        candidates = toc_entries(accurate["lines"])
        if len(candidates) >= 5:
            found, end, entries = page, page, candidates
            break
    if found is None:
        return {
            "toc": [],
            "tocSource": "none",
            "processing": "ready",
            "processingNote": "未找到可靠的原书目录，可按文件页序阅读。",
        }
    for page in range(found + 1, min(book["pages"], found + 6) + 1):
        progress(f"读取目录 · PDF 第 {page} 页")
        result = recognize(book, page, "layout")
        candidates = toc_entries(result["lines"])
        if len(candidates) < 5:
            break
        entries.extend(candidates)
        end = page
    unique = []
    for entry in entries:
        if not any(
            old["title"] == entry["title"] and old["printed"] == entry["printed"]
            for old in unique
        ):
            unique.append(entry)
    entries = unique
    votes = []
    for page in range(end + 1, min(book["pages"], end + 11) + 1):
        progress(f"核对印刷页码 · PDF 第 {page} 页")
        number = printed_number(recognize(book, page, "layout")["lines"])
        if number is not None:
            votes.append(page - number)
        if votes and collections.Counter(votes).most_common(1)[0][1] >= 3:
            break
    counter = collections.Counter(votes)
    offset, count = counter.most_common(1)[0] if counter else (None, 0)
    if count < 2:
        offset = None
    for entry in entries:
        entry["index"] = (
            entry["printed"] + offset
            if offset is not None and 1 <= entry["printed"] + offset <= book["pages"]
            else None
        )
    return {
        "toc": tree_from_entries(entries),
        "tocSource": "ocr-contents",
        "pageOffset": offset,
        "tocPages": [found, end],
        "processing": "ready",
        "mappingConfidence": count / len(votes) if votes else 0,
        "processingNote": "目录已生成。"
        if offset is not None
        else "目录已识别，请校正书页与文件页序的对应关系。",
    }
