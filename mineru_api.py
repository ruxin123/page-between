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
from pdf_enhancement import enrichment_data, source_digest
import service_settings


class MinerUError(ValueError):
    pass


class Paused(MinerUError):
    pass


MAX_BATCH_PAGES = 150
MAX_UPLOAD_BYTES = 200_000_000


def canonical_pages(book):
    target = BOOK_ROOT / book["id"] / "mineru-enhancement.json"
    previous = load(target, None)
    if previous is None:
        previous = enrichment_data({**book, "parseEnabled": True})
    if not isinstance(previous, dict):
        raise MinerUError("已有解析记录无法读取，请保留原书并恢复书库备份。")
    fingerprint = source_digest(book)
    return {
        key: value
        for key, value in previous.items()
        if str(key).isdigit()
        and 1 <= int(key) <= book["pages"]
        and isinstance(value, dict)
        and value.get("sourceHash", fingerprint) == fingerprint
    }


def progress(book):
    pages = sorted(
        int(page)
        for page, value in canonical_pages(book).items()
        if value.get("engine") == "mineru"
    )
    return {"completed": len(pages), "total": book["pages"], "parsedPages": pages}


def result_patch(book, data):
    pages = sorted(
        int(page) for page, value in data.items() if value.get("engine") == "mineru"
    )
    return {
        "enrichmentUrl": url_for(BOOK_ROOT / book["id"] / "mineru-enhancement.json"),
        "enhancedPages": sorted(int(page) for page in data),
        "mineruPages": pages,
        "enhancementRevision": time.time_ns(),
        "processingNote": f"MinerU 已增强 {len(pages)} / {book['pages']} 页；原书版面保留。",
    }


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
    if len(pages) != len(originals):
        raise MinerUError("解析结果缺少页面，已保留其他成功页；可补全未解析页。")
    result = {}
    for index, page in enumerate(pages):
        source_index = page.get("page_idx", index)
        if type(source_index) is not int or not 0 <= source_index < len(originals):
            raise MinerUError("解析结果的页序无法映射回原书。")
        if str(originals[source_index]) in result:
            raise MinerUError(
                "解析结果包含重复页号，已保留其他成功页；可补全未解析页。"
            )
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


def _input_chunk(reader, pages, destination, cancel):
    subset = pages[:MAX_BATCH_PAGES]
    temporary = destination.with_suffix(".part")
    try:
        while subset:
            writer = PdfWriter()
            for page in subset:
                if cancel.is_set():
                    raise Paused("云解析已暂停，可稍后继续。")
                writer.add_page(reader.pages[page - 1])
            writer.add_metadata({"/Title": "Page Between document sample"})
            with temporary.open("wb") as stream:
                writer.write(stream)
            writer.close()
            if temporary.stat().st_size <= MAX_UPLOAD_BYTES:
                temporary.replace(destination)
                return subset
            if len(subset) == 1:
                raise MinerUError(
                    f"PDF 第 {subset[0]} 页超过上传大小限制，无法自动拆分单页。"
                )
            subset = subset[: max(1, len(subset) // 2)]
    finally:
        temporary.unlink(missing_ok=True)


def run(book, pages, phase, cancel, *, fresh=False, publish=None, retry=False):
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
    source_hash = source_digest(book)
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
    target = BOOK_ROOT / book["id"] / "mineru-enhancement.json"
    previous = canonical_pages(book)
    missing = [
        page for page in pages if previous.get(str(page), {}).get("engine") != "mineru"
    ]
    if not fresh and not missing:
        if not target.exists():
            save(target, previous)
        return {
            **result_patch(book, previous),
            "processingNote": "所选页已有解析结果，已复用；原书版面保留。",
        }
    reset_id = fresh if isinstance(fresh, str) else uuid.uuid4().hex if fresh else None
    existing = load(folder / "job.json", {})
    # Adopt the old missing-page operation before publishing changes its missing-page set.
    if not existing and not fresh and missing != pages:
        old_identity = {**identity, "pages": missing}
        old_digest = hashlib.sha256(
            json.dumps(old_identity, sort_keys=True).encode()
        ).hexdigest()[:24]
        old_folder = folder.with_name(old_digest)
        legacy = load(old_folder / "job.json", {})
        if (
            legacy
            and legacy.get("state") != "done"
            and not legacy.get("resetId")
            and all(legacy.get(key) == value for key, value in old_identity.items())
        ):
            old_folder.rename(folder)
            existing = {**legacy, **identity, "planPages": legacy["pages"]}
    invalid = existing.get("state") == "invalid"
    if (
        existing
        and not reset_id
        and any(existing.get(key) != value for key, value in identity.items())
    ):
        raise MinerUError("保存的云任务与原书或服务设置不一致，请重新提交所选页。")
    if invalid and not retry:
        raise MinerUError(
            "此前批次结果不完整，成功页已保存；请在文档处理中补全未解析页。"
        )
    if existing and (
        (reset_id and existing.get("resetId") != reset_id)
        or invalid
        or (existing.get("state") == "done" and not fresh)
    ):
        folder.rename(folder.with_name(digest + "-previous-" + str(time.time_ns())))
        existing = {}
    folder.mkdir(parents=True, exist_ok=True)
    state = existing or {
        **identity,
        "chunks": {},
        "resetId": reset_id,
        "planPages": pages if fresh else missing,
    }
    state.setdefault("planPages", state["pages"])
    plan = state["planPages"]
    if (
        not isinstance(plan, list)
        or len(set(plan)) != len(plan)
        or any(type(page) is not int or page not in pages for page in plan)
    ):
        raise MinerUError("保存的解析计划与原书页段不匹配，请重新提交所选页。")
    state["state"] = "running"
    manifest = folder / "job.json"

    def checkpoint():
        save(manifest, state)

    def check():
        if cancel.is_set():
            raise Paused("云解析已暂停，可稍后继续。")
        if source_digest(book) != source_hash:
            raise Paused(
                "原 PDF 文件已变化，已停止本次解析；请重新打开书籍后选择页段。"
            )

    checkpoint()
    offset, reader = 0, None
    try:
        while offset < len(plan):
            check()
            phase(
                f"准备页段 {offset + 1}-{min(offset + MAX_BATCH_PAGES, len(plan))} / {len(plan)}"
            )
            chunk = state["chunks"].get(str(offset))
            source = folder / f"input-{offset}.pdf"
            archive = folder / f"result-{offset}.zip"
            if chunk is None:
                reader = reader or PdfReader(original)
                subset = _input_chunk(reader, plan[offset:], source, cancel)
                chunk = {"pages": subset}
                state["chunks"][str(offset)] = chunk
                checkpoint()
            subset = chunk["pages"]
            if (
                not subset
                or any(type(page) is not int for page in subset)
                or subset != plan[offset : offset + len(subset)]
            ):
                raise MinerUError("保存的批次页序与解析计划不一致，请重新提交所选页。")
            if not archive.exists():
                task = None
                if chunk.get("batchId"):
                    results = api(
                        config,
                        "/extract-results/batch/" + quote(chunk["batchId"], safe=""),
                    ).get("extract_result", [])
                    if (
                        not isinstance(results, list)
                        or len(results) != 1
                        or not isinstance(results[0], dict)
                    ):
                        raise MinerUError("云任务结果格式不正确，已保留原任务。")
                    task = results[0]
                else:
                    if not source.exists() or source.stat().st_size > MAX_UPLOAD_BYTES:
                        reader = reader or PdfReader(original)
                        subset = _input_chunk(reader, subset, source, cancel)
                        chunk["pages"] = subset
                        checkpoint()
                    check()
                    batch = api(
                        config,
                        "/file-urls/batch",
                        {
                            "files": [
                                {"name": "page-between-pages.pdf", "is_ocr": True}
                            ],
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
                        or not batch_id
                    ):
                        raise MinerUError("MinerU 未返回有效的上传任务。")
                    chunk["batchId"] = batch_id
                    checkpoint()
                    phase(f"上传所选页段 · {len(subset)} 页")
                    upload(config, urls[0], source)
                    chunk["uploaded"] = True
                    checkpoint()
                started = time.monotonic()
                deadline = started + 1800
                while True:
                    check()
                    if task is None:
                        results = api(
                            config,
                            "/extract-results/batch/"
                            + quote(chunk["batchId"], safe=""),
                        ).get("extract_result", [])
                        if (
                            not isinstance(results, list)
                            or len(results) != 1
                            or not isinstance(results[0], dict)
                        ):
                            raise MinerUError("云任务结果格式不正确，已保留原任务。")
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
                    if status == "waiting-file":
                        phase("等待云端确认上传 · 已保留当前任务")
                        if (
                            not chunk.get("uploaded")
                            and time.monotonic() - started > 60
                        ):
                            raise Paused(
                                "云端尚未确认收到文件，已保留任务；可继续等待，若此前上传中断可勾选「重新提交解析」后重试。"
                            )
                    else:
                        if not chunk.get("uploaded"):
                            chunk["uploaded"] = True
                            checkpoint()
                        extraction = task.get("extract_progress", {})
                        phase(
                            f"云端解析 · {offset + int(extraction.get('extracted_pages') or 0)} / {len(plan)} 页"
                        )
                    if time.monotonic() > deadline:
                        raise Paused(
                            "云端尚未确认收到文件，已保存任务；可继续等待或勾选「重新提交解析」后重试。"
                            if status == "waiting-file"
                            else "云端仍在处理，已保存任务，可稍后继续查询。"
                        )
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
            layout = next(extracted.rglob("layout.json"), None) or next(
                extracted.rglob("*_middle.json"), None
            )
            if layout is None:
                raise MinerUError("结果中没有可定位的页面结构。")
            try:
                output = normalized_pages(load(layout, {}), subset)
            except MinerUError:
                state["state"] = "invalid"
                state["invalidPages"] = subset
                checkpoint()
                raise
            check()
            previous = canonical_pages(book)
            for value in output.values():
                value["sourceHash"] = source_hash
            previous.update(output)
            save(target, previous)
            patch = result_patch(book, previous)
            book.update(patch)
            if publish:
                publish(patch)
            chunk["state"] = "published"
            checkpoint()
            phase(
                f"已增强 {len(patch['mineruPages'])} / {book['pages']} 页，已完成页可直接阅读。"
            )
            offset += len(subset)
    finally:
        if reader:
            reader.close()
    state["state"] = "done"
    checkpoint()
    return result_patch(book, canonical_pages(book))
