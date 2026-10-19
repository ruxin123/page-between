"""MinerU cloud jobs with local checkpoints and page coordinates for the original PDF."""

import hashlib
import http.client
import json
import math
import re
import shutil
import tempfile
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, build_opener

from pypdf import PdfReader, PdfWriter
from lxml import etree
from ai_tutor import NoRedirect
from book_import import BOOK_ROOT, ROOT, extract_zip, path_for, url_for
from storage import load, save
from pdf_enhancement import enrichment_data
import service_settings


class MinerUError(ValueError):
    pass


class Paused(MinerUError):
    pass


def page_range(value, total):
    if (
        not isinstance(value, str)
        or len(value) > 2000
        or type(total) is not int
        or total < 1
    ):
        raise MinerUError("页码范围无效。")
    pages = set()
    for part in value.replace("，", ",").split(","):
        match = re.fullmatch(r"\s*(\d+)(?:\s*-\s*(\d+))?\s*", part)
        if not match:
            raise MinerUError("请填写 PDF 文件页序，例如 29-34 或 2,5-8。")
        start, end = int(match[1]), int(match[2] or match[1])
        if not 1 <= start <= end <= total:
            raise MinerUError("页码超出本书范围，请使用 PDF 文件页序。")
        pages.update(range(start, end + 1))
    return sorted(pages)


def resource_address(url, base):
    if not isinstance(url, str) or len(url) > 16000:
        raise MinerUError("解析服务返回的资源地址无效。")
    try:
        address, origin = urlsplit(url), urlsplit(base)
        address.port
        origin.port
    except ValueError:
        raise MinerUError("解析服务返回的资源地址无效。") from None
    host = address.hostname or ""
    trusted = any(
        host == domain or host.endswith("." + domain)
        for domain in ("mineru.net", "aliyuncs.com", "openxlab.org.cn")
    )
    same_origin = (address.scheme, host, address.port) == (
        origin.scheme,
        origin.hostname,
        origin.port,
    )
    if (
        address.username
        or address.password
        or address.fragment
        or not host
        or not (
            address.scheme == "https"
            and (trusted or same_origin)
            or address.scheme == "http"
            and same_origin
            and host in {"localhost", "127.0.0.1", "::1"}
        )
    ):
        raise MinerUError("解析服务返回了不受支持的资源地址。")
    return address


def api(config, path, body=None):
    request = Request(
        config["baseUrl"] + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Authorization": "Bearer " + config["key"],
            "Content-Type": "application/json",
        },
    )
    try:
        with build_opener(NoRedirect()).open(request, timeout=45) as response:
            raw = response.read(2 * 1024**2 + 1)
        if len(raw) > 2 * 1024**2:
            raise MinerUError("解析服务响应过大，请稍后重试。")
        result = json.loads(raw)
    except HTTPError as error:
        if error.code in {401, 403}:
            raise MinerUError(
                "MinerU 未允许本次请求，请在设置中检查 Token 与权限。"
            ) from None
        raise MinerUError(
            f"MinerU 返回 HTTP {error.code}，可稍后继续已有任务。"
        ) from None
    except (OSError, URLError, TimeoutError):
        raise MinerUError("暂时无法连接 MinerU，可稍后继续已有任务。") from None
    except ValueError:
        raise MinerUError("MinerU 返回了无法读取的响应。") from None
    if not isinstance(result, dict):
        raise MinerUError("MinerU 响应格式不正确。")
    if result.get("code") != 0:
        messages = {
            "A0202": "MinerU Token 无效，请在设置中更新。",
            "A0211": "MinerU Token 已过期，请在设置中更新。",
            "-60012": "此前的云任务已不存在，请重新提交解析。",
            "-60018": "MinerU 今日解析次数已达上限，请稍后继续。",
        }
        raise MinerUError(
            messages.get(
                str(result.get("code")), "MinerU 未完成请求，请稍后重试或检查服务设置。"
            )
        )
    if not isinstance(result.get("data"), dict):
        raise MinerUError("MinerU 响应缺少任务信息。")
    return result["data"]


def upload(config, url, source):
    address = resource_address(url, config["baseUrl"])
    connection_type = (
        http.client.HTTPSConnection
        if address.scheme == "https"
        else http.client.HTTPConnection
    )
    connection = connection_type(address.hostname, address.port, timeout=120)
    try:
        target = address.path + ("?" + address.query if address.query else "")
        with source.open("rb") as stream:
            connection.request(
                "PUT", target, stream, {"Content-Length": str(source.stat().st_size)}
            )
            response = connection.getresponse()
            response.read(65536)
            if response.status not in {200, 201, 204}:
                raise MinerUError("页段上传未完成，可稍后继续任务。")
    except (OSError, http.client.HTTPException):
        raise MinerUError("上传连接中断，可稍后继续任务。") from None
    finally:
        connection.close()


def download(config, url, destination):
    resource_address(url, config["baseUrl"])
    temporary = destination.with_suffix(".part")
    try:
        with (
            build_opener(NoRedirect()).open(Request(url), timeout=120) as response,
            temporary.open("wb") as output,
        ):
            size = 0
            while block := response.read(1024 * 1024):
                size += len(block)
                if size > 300 * 1024**2:
                    raise MinerUError("解析结果超过本机处理上限，请缩小页段。")
                output.write(block)
        temporary.replace(destination)
    except (OSError, URLError, http.client.HTTPException):
        raise MinerUError("结果下载未完成，可稍后继续已有云任务。") from None
    finally:
        temporary.unlink(missing_ok=True)


def block_text(block):
    lines = []
    for line in block.get("lines", []):
        parts = []
        for span in line.get("spans", []):
            value = span.get("content", "")
            if span.get("type") in {"inline_equation", "interline_equation"}:
                value = str(value)
                if span.get("type") == "inline_equation":
                    value = "$" + value + "$"
            if isinstance(value, str):
                parts.append(value)
            if isinstance(span.get("html"), str):
                parts.append(span["html"])
        lines.append("".join(parts))
    children = [block_text(child) for child in block.get("blocks", [])]
    return "\n".join(value for value in [*lines, *children] if value).strip()


def table_html(block):
    for line in block.get("lines", []):
        for span in line.get("spans", []):
            if isinstance(span.get("html"), str):
                return span["html"]
    for child in block.get("blocks", []):
        value = table_html(child)
        if value:
            return value
    return ""


def table_text(value):
    try:
        root = etree.fromstring(value.encode(), etree.HTMLParser(no_network=True))
        return "\n".join(
            "\t".join(
                "".join(cell.itertext()).strip() for cell in row.xpath("./td|./th")
            )
            for row in root.xpath(".//tr")
        )
    except (etree.Error, AttributeError):
        return ""


def normalized_pages(document, originals):
    pages = document.get("pdf_info") if isinstance(document, dict) else None
    if not isinstance(pages, list):
        raise MinerUError("结果缺少可定位的页面结构，请检查 MinerU 输出版本。")
    result = {}
    for index, page in enumerate(pages):
        source_index = page.get("page_idx", index)
        if type(source_index) is not int or not 0 <= source_index < len(originals):
            raise MinerUError("解析结果的页序无法映射回原书。")
        size = page.get("page_size", [])
        if len(size) != 2 or any(
            not isinstance(value, (int, float))
            or not math.isfinite(value)
            or value <= 0
            for value in size
        ):
            raise MinerUError("解析结果缺少有效的页面尺寸。")
        width, height = size
        blocks = []
        for order, block in enumerate(page.get("para_blocks", [])):
            rectangle = block.get("bbox", [])
            if len(rectangle) != 4 or any(
                not isinstance(value, (int, float)) or not math.isfinite(value)
                for value in rectangle
            ):
                continue
            left, top, right, bottom = rectangle
            if not (
                0 <= left < right <= width * 1.01 and 0 <= top < bottom <= height * 1.01
            ):
                raise MinerUError("解析区块的坐标与页面不匹配，请保留原页并重试。")
            kind = {"interline_equation": "equation", "title": "text"}.get(
                block.get("type"), block.get("type")
            )
            if kind not in {"text", "equation", "image", "table", "list"}:
                continue
            html = table_html(block) if kind == "table" else ""
            blocks.append(
                {
                    "id": f"p{originals[source_index]}-b{order}",
                    "type": "text" if kind == "list" else kind,
                    "text": table_text(html) if html else block_text(block),
                    "tableHtml": html or None,
                    "bbox": [
                        left / width,
                        top / height,
                        min(1, right / width),
                        min(1, bottom / height),
                    ],
                    "headingLevel": block.get("level")
                    if block.get("type") == "title"
                    else None,
                    "order": order,
                }
            )
        result[str(originals[source_index])] = {
            "blocks": blocks,
            "engine": "mineru",
            "size": size,
        }
    return result


def run(book, pages, phase, cancel, *, fresh=False):
    if (
        not pages
        or pages != sorted(set(pages))
        or any(
            type(page) is not int or not 1 <= page <= book["pages"] for page in pages
        )
    ):
        raise MinerUError("请选择本书有效的 PDF 文件页序。")
    config = service_settings.validated(
        "mineru", service_settings.effective("mineru"), require_key=True
    )
    original = path_for(book["url"])
    with original.open("rb") as stream:
        source_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    identity = {
        "source": source_hash,
        "pages": pages,
        "baseUrl": config["baseUrl"],
        "model": config["model"],
    }
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[
        :24
    ]
    folder = BOOK_ROOT / book["id"] / "mineru" / digest
    reset_id = fresh if isinstance(fresh, str) else uuid.uuid4().hex if fresh else None
    existing = load(folder / "job.json", {})
    previous = enrichment_data(book)
    if not fresh and (not existing or existing.get("state") == "done"):
        missing = [
            page
            for page in pages
            if previous.get(str(page), {}).get("engine") != "mineru"
        ]
        if not missing:
            return {
                "enrichmentUrl": book["enrichmentUrl"],
                "enhancedPages": sorted(
                    int(page) for page in previous if str(page).isdigit()
                ),
                "processingNote": "所选页已有解析结果，已复用；原书版面保留。",
            }
        if missing != pages:
            return run(book, missing, phase, cancel)
    if reset_id and existing.get("resetId") != reset_id and folder.exists():
        folder.rename(folder.with_name(digest + "-previous-" + str(time.time_ns())))
    folder.mkdir(parents=True, exist_ok=True)
    manifest = folder / "job.json"
    state = load(manifest, {**identity, "chunks": {}, "resetId": reset_id})
    reader = None
    output = {}

    def checkpoint():
        save(manifest, state)

    checkpoint()

    def check():
        if cancel.is_set():
            raise Paused("云解析已暂停，可稍后继续。")

    for offset in range(0, len(pages), 150):
        check()
        subset = pages[offset : offset + 150]
        chunk = state["chunks"].setdefault(str(offset), {"pages": subset})
        archive = folder / f"result-{offset}.zip"
        phase(f"准备页段 {offset + 1}-{offset + len(subset)} / {len(pages)}")
        if not archive.exists():
            source = folder / f"input-{offset}.pdf"
            if not source.exists():
                reader = reader or PdfReader(original)
                writer = PdfWriter()
                for page in subset:
                    check()
                    writer.add_page(reader.pages[page - 1])
                writer.add_metadata({"/Title": "Page Between document sample"})
                temporary_source = source.with_suffix(".part")
                with temporary_source.open("wb") as stream:
                    writer.write(stream)
                writer.close()
                temporary_source.replace(source)
            if source.stat().st_size > 200 * 1024**2:
                raise MinerUError("所选页段超过上传大小限制，请缩小范围。")
            task = None
            if chunk.get("batchId"):
                results = api(
                    config, "/extract-results/batch/" + quote(chunk["batchId"], safe="")
                ).get("extract_result", [])
                task = results[0] if len(results) == 1 else None
            if task is None or task.get("state") == "waiting-file":
                check()
                batch = api(
                    config,
                    "/file-urls/batch",
                    {
                        "files": [{"name": "page-between-pages.pdf", "is_ocr": True}],
                        "model_version": config["model"],
                        "language": "ch"
                        if book.get("language", "").startswith("zh")
                        else "en",
                        "enable_formula": True,
                        "enable_table": True,
                    },
                )
                urls, batch_id = batch.get("file_urls"), batch.get("batch_id")
                if (
                    not isinstance(urls, list)
                    or len(urls) != 1
                    or not isinstance(batch_id, str)
                ):
                    raise MinerUError("MinerU 未返回有效的上传任务。")
                chunk["batchId"] = batch_id
                checkpoint()
                phase(f"上传所选页段 · {len(subset)} 页")
                upload(config, urls[0], source)
                task = None
            deadline = time.monotonic() + 1800
            while True:
                check()
                if task is None:
                    results = api(
                        config,
                        "/extract-results/batch/" + quote(chunk["batchId"], safe=""),
                    ).get("extract_result", [])
                    if len(results) != 1 or not isinstance(results[0], dict):
                        raise MinerUError("云任务结果格式不正确。")
                    task = results[0]
                status = task.get("state")
                if status == "failed":
                    raise MinerUError(
                        "MinerU 未能解析这个页段，可重新提交或继续阅读原页。"
                    )
                if status == "done":
                    phase("下载并校验解析结果")
                    download(config, task.get("full_zip_url"), archive)
                    chunk["state"] = "downloaded"
                    checkpoint()
                    break
                progress = task.get("extract_progress", {})
                phase(
                    f"云端解析 · {offset + int(progress.get('extracted_pages') or 0)} / {len(pages)} 页"
                )
                if time.monotonic() > deadline:
                    raise Paused("云端仍在处理，已保存任务，可稍后继续查询。")
                cancel.wait(3)
                task = None
        check()
        extracted = folder / f"result-{offset}"
        if not extracted.exists():
            temporary = Path(tempfile.mkdtemp(prefix=".extract-", dir=folder))
            try:
                extract_zip(archive, temporary)
                temporary.rename(extracted)
            finally:
                shutil.rmtree(temporary, ignore_errors=True)
        layout = next(extracted.rglob("layout.json"), None)
        if layout is None:
            layout = next(extracted.rglob("*_middle.json"), None)
        if layout is None:
            raise MinerUError("结果中没有可定位的页面结构。")
        output.update(normalized_pages(load(layout, {}), subset))
    check()
    previous = {
        key: value
        for key, value in enrichment_data(book).items()
        if str(key).isdigit() and isinstance(value, dict)
    }
    previous.update(output)
    target = BOOK_ROOT / book["id"] / "mineru-enhancement.json"
    save(target, previous)
    state["state"] = "done"
    checkpoint()
    return {
        "enrichmentUrl": url_for(target),
        "enhancedPages": sorted(int(page) for page in previous),
        "enhancementRevision": time.time_ns(),
        "processingNote": f"已增强 {len(previous)} 页；原书版面保留。",
    }
