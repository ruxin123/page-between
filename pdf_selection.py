"""Align canonical block text to the unchanged geometry of PDF text spans."""

import math
import re
import unicodedata
from functools import lru_cache
from difflib import SequenceMatcher

MATH_PATTERN = (
    r"(?<!\\)(?:\$\$(?:(?!\$\$)[\s\S])+?\$\$|\$(?!\$)(?:\\[\s\S]|[^$\\])+\$|"
    r"\\\[(?:(?!\\\])[\s\S])+?\\\]|\\\((?:(?!\\\))[\s\S])+?\\\))"
)
MATH = re.compile(MATH_PATTERN)
TOKENS = re.compile("(?P<math>" + MATH_PATTERN + r")|[\s\S]")


def utf16(value):
    return len(value.encode("utf-16-le")) // 2


def standalone_math(value):
    """Return a complete delimited formula, including trailing punctuation."""
    match = re.fullmatch(
        r"\s*(?P<formula>" + MATH_PATTERN + r")\s*(?P<punct>[,;:.!?，；：。！？]*)\s*",
        value,
    )
    if not match:
        return None
    formula = match["formula"]
    delimiter = 2 if formula.startswith(("$$", r"\[", r"\(")) else 1
    return formula[delimiter:-delimiter] + match["punct"]


def normalized(value, *, canonical=False):
    text, offsets, position = [], [], 0
    # Match visible symbols without using TeX command lengths; each symbol maps
    # back to the entire original formula, preserving complete-object selection.
    tokens = ((match.group(), match.group("math") is not None) for match in TOKENS.finditer(value)) if canonical else ((char, False) for char in value)
    for char, formula in tokens:
        end = position + utf16(char)
        if formula:
            for part in unicodedata.normalize("NFKC", math_comparison(char)).casefold():
                if not part.isspace():
                    text.append(part)
                    offsets.append((position, end))
            position = end
            continue
        normalized_char = unicodedata.normalize("NFKC", char).casefold()
        normalized_char = normalized_char.translate(str.maketrans("‘’“”", "''\"\""))
        for part in normalized_char:
            if not part.isspace():
                text.append(part)
                offsets.append((position, end))
        position = end
    return "".join(text), offsets


@lru_cache(maxsize=8192)
def math_comparison(value):
    """Compare visible symbols while every matched symbol still selects the full original formula."""
    body = standalone_math(value) or ""
    body = re.sub(r"\\(?:begin|end)\s*\{[^}]*\}", "", body)
    symbols = {"emptyset":"∅", "varnothing":"∅", "in":"∈", "notin":"∉", "times":"×", "circ":"∘", "sim":"∼", "subset":"⊂", "subseteq":"⊆", "cup":"∪", "cap":"∩", "to":"→", "mapsto":"↦", "leq":"≤", "geq":"≥", "neq":"≠", "alpha":"α", "beta":"β", "gamma":"γ", "sigma":"σ", "tau":"τ", "pi":"π", "infty":"∞"}
    decoration = {"bar", "overline", "underline", "hat", "tilde", "mathbf", "mathbb", "mathrm", "mathcal", "text", "operatorname", "left", "right", "displaystyle", "quad", "qquad"}
    body = re.sub(r"\\([A-Za-z]+)", lambda m: symbols.get(m[1], "" if m[1] in decoration else m[1] if m[1] in {"sin","cos","tan","log","lim","det","exp"} else "\ufffc"), body)
    body = re.sub(r"\\[,;! ]", "", body)
    return re.sub(r"[{}_^\\]", "", body) or "\ufffc"


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


@lru_cache(maxsize=512)
def split_continuation(original, canonical):
    """Recover an adjacent-page continuation without rewriting any source characters."""
    left, _ = normalized(original)
    if len(left) < 30:
        return None
    formulas = list(MATH.finditer(canonical))
    choices = []
    for match in re.finditer(r"\n", canonical):
        boundary = match.end()
        if any(part.start() < boundary < part.end() for part in formulas):
            continue
        right, _ = normalized(canonical[boundary:], canonical=True)
        if not right or max(len(left), len(right)) > 16000:
            continue
        anchors = SequenceMatcher(None, left[:64], right[:64], autojunk=False).get_matching_blocks()
        if not any(item.size >= 8 and item.a <= 8 and item.b <= 8 for item in anchors):
            continue
        ratio = SequenceMatcher(None, left, right, autojunk=False).ratio()
        if ratio >= .8:
            choices.append((ratio, boundary))
    choices.sort(reverse=True)
    if not choices or (len(choices) > 1 and choices[0][0] - choices[1][0] < .05):
        return None
    boundary = choices[0][1]
    return canonical[:boundary].rstrip("\n"), canonical[boundary:]


def align_spans(spans, blocks):
    if not isinstance(spans, list) or len(spans) > 5000:
        raise ValueError("页面文字层过大。")
    total = 0
    groups = {}
    orders = {id(block): order for order, block in enumerate(blocks)}
    for block in blocks:
        if block.get("text") and (
            block.get("type") in {"equation", "table"}
            or (block.get("type") == "text" and standalone_math(block["text"]) is not None)
        ):
            groups[block.get("id") or str(block["bbox"])] = {
                "text": block["text"],
                "spans": [],
                "whole": True,
                "bbox": block["bbox"],
                "order": orders[id(block)],
            }
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
            if block.get("type") in {"text", "equation", "table"}
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
        groups.setdefault(
            key,
            {
                "text": block["text"],
                "spans": [],
                "whole": block.get("type") in {"equation", "table"},
                "order": orders[id(block)],
            },
        )["spans"].append((index, span["text"]))
    result = []
    for group in sorted(groups.values(), key=lambda group: group["order"]):
        canonical = group["text"]
        if group["whole"]:
            result.append(
                {
                    "text": canonical,
                    "whole": True,
                    "spans": [{"index": index} for index, _ in group["spans"]],
                    "bbox": group["bbox"],
                    "order": group["order"],
                }
            )
            continue
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
                "order": group["order"],
                "spans": mapped,
                "math": [
                    [utf16(canonical[: m.start()]), utf16(canonical[: m.end()])]
                    for m in MATH.finditer(canonical)
                ],
            }
        )
    return result
