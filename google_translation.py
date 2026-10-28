"""Google's web translation endpoint, as used by the user's Bob Google plugin."""

import json
import re
import socket
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, build_opener

from ai_tutor import NoRedirect
from pdf_selection import MATH

ENDPOINT = "https://translate.google.com/translate_a/single"
COOLDOWN_UNTIL = 0


def chunks(text, maximum=4000):
    while len(text) > maximum:
        split = max(text.rfind("\n", 0, maximum), text.rfind(" ", 0, maximum))
        if split < maximum // 2:
            split = maximum
            # A protected formula must never be cut in half.
            token = text.rfind("PBMZ", 0, split)
            if token >= 0 and "END" not in text[token:split]:
                split = token
        for formula in MATH.finditer(text):
            if formula.start() < split < formula.end():
                split = formula.start() or formula.end()
                break
        yield text[:split]
        text = text[split:]
    if text:
        yield text


def request(text, source, target, control, *, timeout=25):
    global COOLDOWN_UNTIL
    if control["event"].is_set():
        raise ValueError("已停止翻译。")
    if time.time() < COOLDOWN_UNTIL:
        raise ValueError("Google 暂时限流，请稍后重试或切换 AI 翻译。")
    query = urlencode({"client": "gtx", "sl": source, "tl": target, "dt": "t", "dj": "1", "ie": "UTF-8", "oe": "UTF-8"})
    # Do not follow redirects carrying the selected text to another host.
    try:
        with build_opener(NoRedirect()).open(Request(ENDPOINT + "?" + query, data=urlencode({"q": text}).encode(), headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"}), timeout=timeout) as response:
            control["socket"] = getattr(getattr(response.fp, "raw", None), "_sock", None)
            if control["event"].is_set():
                raise ValueError("已停止翻译。")
            raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError("Google 返回的译文过长，请缩小选段。")
        value = json.loads(raw)
        if not isinstance(value, dict) or not isinstance(value.get("sentences"), list):
            raise ValueError("Google 翻译接口返回格式已改变，请重试或切换 AI 翻译。")
        translated = "".join(row.get("trans", "") for row in value["sentences"] if isinstance(row, dict))
        if not translated.strip():
            raise ValueError("Google 没有返回译文，请重试。")
        return translated, value.get("src", source)
    except HTTPError as error:
        if error.code == 429:
            COOLDOWN_UNTIL = time.time() + 60
            raise ValueError("Google 暂时限流，请一分钟后重试或切换 AI 翻译。") from None
        raise ValueError(f"Google 翻译返回 HTTP {error.code}，请稍后重试。") from None
    except (URLError, OSError, TimeoutError, socket.timeout):
        raise ValueError("无法连接 Google 翻译，请检查网络后重试，或切换 AI 翻译。") from None
    except (json.JSONDecodeError, TypeError):
        raise ValueError("Google 翻译响应不完整，请重试。") from None


def translate(text, source, target, control):
    source = "zh-CN" if source == "zh" else source
    if target == "auto":
        # Detect from the actual prose, rather than Han characters inside TeX.
        probe = re.sub(r"PBMZ[a-zA-Z0-9]+END", "", text)
        probe = MATH.sub("", probe)
        target = "en" if source.startswith("zh") or source == "auto" and re.search(r"[\u3400-\u9fff]", probe) else "zh-CN"
    elif target == "zh":
        target = "zh-CN"
    parts, language = [], source
    for chunk in chunks(text):
        leading = chunk[:len(chunk) - len(chunk.lstrip())]
        trailing = chunk[len(chunk.rstrip()):]
        if not chunk.strip():
            parts.append(chunk)
            continue
        if MATH.fullmatch(chunk.strip()):
            parts.append(chunk)
            continue
        translated, detected = request(chunk.strip(), source, target, control)
        parts.append(leading + translated.strip() + trailing)
        if language == "auto":
            language = detected
    return {"translation": "".join(parts), "detectedLanguage": language, "explanation": ""}
