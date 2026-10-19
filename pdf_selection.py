"""Align canonical block text to the unchanged geometry of PDF text spans."""

import math
import re
import unicodedata
from difflib import SequenceMatcher


def utf16(value):
    return len(value.encode("utf-16-le")) // 2


def normalized(value, *, canonical=False):
    text, offsets, position = [], [], 0
    for char in value:
        end = position + utf16(char)
        normalized_char = unicodedata.normalize("NFKC", char).casefold()
        normalized_char = normalized_char.translate(str.maketrans("‘’“”", "''\"\""))
        for part in normalized_char:
            if not part.isspace() and not (canonical and part == "$"):
                text.append(part)
                offsets.append((position, end))
        position = end
    return "".join(text), offsets


def character_map(original, canonical):
    left, original_offsets = normalized(original)
    right, canonical_offsets = normalized(canonical, canonical=True)
    if not left or not right or len(left) > 16000 or len(right) > 16000:
        return None
    matcher = SequenceMatcher(None, left, right, autojunk=False)
    if matcher.ratio() < 0.65:
        return None
    result = [None] * utf16(original)
    for tag, a0, a1, b0, b1 in matcher.get_opcodes():
        if tag == "insert":
            continue
        if tag != "equal" and max(a1 - a0, b1 - b0) > max(20, len(left) * 0.15):
            continue
        for index in range(a0, a1):
            if b0 == b1:
                start = end = (
                    canonical_offsets[b0][0] if b0 < len(right) else utf16(canonical)
                )
            else:
                lo = b0 + (index - a0) * (b1 - b0) // (a1 - a0)
                hi = b0 + math.ceil((index - a0 + 1) * (b1 - b0) / (a1 - a0))
                start, end = canonical_offsets[lo][0], canonical_offsets[hi - 1][1]
            for offset in range(*original_offsets[index]):
                previous = result[offset]
                result[offset] = (
                    [min(start, previous[0]), max(end, previous[1])]
                    if previous
                    else [start, end]
                )
    return result


def align_spans(spans, blocks):
    if not isinstance(spans, list) or len(spans) > 5000:
        raise ValueError("页面文字层过大。")
    total = 0
    groups = {}
    for index, span in enumerate(spans):
        if not isinstance(span, dict) or not isinstance(span.get("text"), str):
            raise ValueError("页面文字层无效。")
        total += len(span["text"])
        box = span.get("bbox")
        if (
            total > 120000
            or not isinstance(box, list)
            or len(box) != 4
            or any(
                type(value) not in {int, float} or not math.isfinite(value)
                for value in box
            )
        ):
            raise ValueError("页面文字坐标无效。")
        x, y = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        candidates = [
            block
            for block in blocks
            if block.get("type") == "text"
            and block.get("text")
            and block["bbox"][0] - 0.003 <= x <= block["bbox"][2] + 0.003
            and block["bbox"][1] - 0.003 <= y <= block["bbox"][3] + 0.003
        ]
        if not candidates:
            continue
        block = min(
            candidates,
            key=lambda b: (b["bbox"][2] - b["bbox"][0]) * (b["bbox"][3] - b["bbox"][1]),
        )
        key = block.get("id") or str(block["bbox"])
        groups.setdefault(key, {"text": block["text"], "spans": []})["spans"].append(
            (index, span["text"])
        )
    result = []
    for group in groups.values():
        canonical = group["text"]
        mapping = character_map("".join(text for _, text in group["spans"]), canonical)
        if mapping is None:
            continue
        mapped, offset = [], 0
        for index, text in group["spans"]:
            size = utf16(text)
            mapped.append({"index": index, "map": mapping[offset : offset + size]})
            offset += size
        result.append(
            {
                "text": canonical,
                "spans": mapped,
                "math": [
                    [utf16(canonical[: m.start()]), utf16(canonical[: m.end()])]
                    for m in re.finditer(r"\$[^$]+\$", canonical)
                ],
            }
        )
    return result
