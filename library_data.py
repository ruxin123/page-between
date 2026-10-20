"""Verified library backups and recovery applied before the next service starts."""

import copy
import hashlib
import json
import re
import shutil
import tempfile
import time
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit

from paths import DATA, DATA_PREFIX, CACHE, APP_MODE
from storage import load, save
from epub_export import filename
from pdf_enhancement import enrichment_data

RECORDS = {"library.json", "state.json", "ai-conversations.json"}
MAX_ARCHIVE = 2 * 1024**3
MAX_EXPANDED = 10 * 1024**3


def record_path(name):
    return DATA.parent / (DATA.name + "-" + name + ".json")


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def allowed_path(name):
    path = PurePosixPath(name)
    return (
        isinstance(name, str)
        and "\\" not in name
        and not path.is_absolute()
        and path.as_posix() == name
        and all(
            part not in {"", ".", ".."} and not part.startswith(".")
            for part in path.parts
        )
        and (
            name in RECORDS
            or len(path.parts) >= 3
            and path.parts[0] == "books"
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,80}", path.parts[1])
        )
    )


def validate(root):
    collection = load(root / "library.json", None)
    if not isinstance(collection, dict) or not isinstance(
        collection.get("books"), list
    ):
        raise ValueError("备份中没有有效的书库。")
    books = {
        book.get("id"): book for book in collection["books"] if isinstance(book, dict)
    }
    if len(books) != len(collection["books"]) or any(
        not isinstance(ident, str)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,80}", ident)
        for ident in books
    ):
        raise ValueError("备份中的书籍标识无效或重复。")

    def urls(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if (
                    key
                    in {"url", "originalUrl", "contentUrl", "enrichmentUrl", "cover"}
                    and item
                    and (
                        not isinstance(item, str)
                        or not item.startswith(DATA_PREFIX + "/books/")
                    )
                ):
                    raise ValueError("备份含有无法验证的书籍资源地址。")
                urls(item)
        elif isinstance(value, list):
            for item in value:
                urls(item)
        elif isinstance(value, str) and value.startswith(
            ("/data/books/", "/demo-data/books/")
        ):
            if not value.startswith(DATA_PREFIX + "/books/"):
                raise ValueError("个人和演示书库不能混合恢复。")
            relative = unquote(urlsplit(value).path[len(DATA_PREFIX) + 1 :])
            path = (root / relative).resolve()
            if (
                not path.is_relative_to((root / "books").resolve())
                or not path.is_file()
            ):
                raise ValueError("备份缺少书籍资源，或资源超出书库范围。")

    for ident, book in books.items():
        if (
            book.get("type") not in {"pdf", "txt", "epub"}
            or not isinstance(book.get("title"), str)
            or not isinstance(book.get("chapters", []), list)
            or not isinstance(book.get("toc", []), list)
        ):
            raise ValueError("备份中的书籍结构不完整。")
        if not (root / "books" / ident / "book.json").is_file():
            raise ValueError("备份缺少书籍记录。")
        urls(book)
    state = load(root / "state.json", {})
    if (
        not isinstance(state, dict)
        or not isinstance(state.get("prefs", {}), dict)
        or not isinstance(state.get("positions", {}), dict)
        or not isinstance(state.get("bookmarks", []), list)
    ):
        raise ValueError("备份中的阅读记录无效。")
    conversations = load(root / "ai-conversations.json", {"conversations": []})
    if (
        not isinstance(conversations, dict)
        or not isinstance(conversations.get("conversations"), list)
        or len(conversations["conversations"]) > 10000
    ):
        raise ValueError("备份中的对话记录无效。")
    return collection, state, conversations


def cloud_cache_folders():
    folders = []
    for book in load(DATA / "library.json", {"books": []})["books"]:
        directory = DATA / "books" / book["id"]
        if (
            book.get("processing") == "pending"
            or not (directory / "mineru-enhancement.json").is_file()
        ):
            continue
        for path in (directory / "mineru").glob("*"):
            if not path.is_dir() or path.is_symlink():
                continue
            try:
                finished = load(path / "job.json", {}).get("state") == "done"
            except (OSError, ValueError):
                finished = False
            if finished or "-previous-" in path.name:
                folders.append(path)
    return folders


def backup(snapshot):
    snapshot = copy.deepcopy(snapshot)
    directory = CACHE / "exports"
    directory.mkdir(parents=True, exist_ok=True)
    ident = uuid.uuid4().hex
    target = directory / (ident + ".pbbackup")
    temporary = directory / (ident + ".part")
    overrides = {
        name: json.dumps(value, ensure_ascii=False).encode()
        for name, value in snapshot.items()
        if name in RECORDS
    }
    files = {}
    cached = cloud_cache_folders()
    try:
        with zipfile.ZipFile(
            temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=1
        ) as archive:

            def put(name, content):
                archive.writestr("Library/" + name, content)
                files[name] = {
                    "sha256": hashlib.sha256(content).hexdigest(),
                    "size": len(content),
                }

            for book in snapshot["library.json"]["books"]:
                if book.get("enrichmentUrl", "").startswith("/assets/"):
                    value = enrichment_data({**book, "parseEnabled": True})
                    if not value:
                        raise ValueError("附加解析资源缺失，请先重新解析或检查原书库。")
                    name = "books/" + book["id"] + "/legacy-enhancement.json"
                    put(name, json.dumps(value, ensure_ascii=False).encode())
                    book["enrichmentUrl"] = DATA_PREFIX + "/" + name
                for path in (DATA / "books" / book["id"]).rglob("*"):
                    if (
                        not path.is_file()
                        or path.name.startswith(".")
                        or path.suffix == ".part"
                        or path.name == "book.json"
                    ):
                        continue
                    if any(path.is_relative_to(folder) for folder in cached):
                        continue
                    if path.is_symlink():
                        raise ValueError("书库包含符号链接，请先确认资源完整。")
                    name = path.relative_to(DATA).as_posix()
                    before = path.stat()
                    with (
                        path.open("rb") as source,
                        archive.open(
                            "Library/" + name, "w", force_zip64=True
                        ) as output,
                    ):
                        checksum, size = hashlib.sha256(), 0
                        while content := source.read(1024 * 1024):
                            output.write(content)
                            checksum.update(content)
                            size += len(content)
                    after = path.stat()
                    if (before.st_size, before.st_mtime_ns) != (
                        after.st_size,
                        after.st_mtime_ns,
                    ):
                        raise ValueError("书籍正在更新，请等待后台任务结束后重新备份。")
                    files[name] = {"sha256": checksum.hexdigest(), "size": size}
                put(
                    "books/" + book["id"] + "/book.json",
                    json.dumps(book, ensure_ascii=False).encode(),
                )
            overrides["library.json"] = json.dumps(
                snapshot["library.json"], ensure_ascii=False
            ).encode()
            for name, content in overrides.items():
                put(name, content)
            archive.writestr(
                "manifest.json",
                json.dumps(
                    {
                        "schema": 1,
                        "prefix": DATA_PREFIX,
                        "createdAt": time.time(),
                        "files": files,
                    }
                ),
            )
        if (
            temporary.stat().st_size > MAX_ARCHIVE
            or sum(value["size"] for value in files.values()) > MAX_EXPANDED
        ):
            raise ValueError("书库超过当前备份容量上限，请分开保留原书与阅读记录。")
        temporary.replace(target)
        return {
            "id": target.name,
            "name": filename("页间书库-" + time.strftime("%Y%m%d-%H%M"), ".pbbackup"),
            "books": len(snapshot["library.json"]["books"]),
            "files": len(files),
        }
    finally:
        temporary.unlink(missing_ok=True)


def normalize_recovery(root):
    from ai_tutor import answer_html, source_for

    collection, _, conversations = validate(root)
    books = {book["id"]: book for book in collection["books"]}
    for job in collection.get("jobs", []):
        if job.get("status") == "running":
            job.update(
                status="paused" if job.get("kind") == "mineru" else "ready",
                phase="从备份恢复，可按需继续解析。",
            )
    for book in books.values():
        if book.get("processing") == "pending":
            book.update(
                processing="ready", processingNote="已从备份恢复，可按需继续解析。"
            )
        save(root / "books" / book["id"] / "book.json", book)
    for item in conversations["conversations"]:
        if (
            not isinstance(item, dict)
            or item.get("book") not in books
            or not isinstance(item.get("id"), str)
            or not re.fullmatch(r"[0-9a-f]{32}", item["id"])
            or not isinstance(item.get("messages"), list)
            or not item["messages"]
            or len(item["messages"]) > 1000
        ):
            raise ValueError("备份中的对话结构无效。")
        book = books[item["book"]]
        original_source = item.get("source")
        item["source"] = source_for(book, original_source, resource_root=root / "books")
        if (
            isinstance(original_source.get("citation"), str)
            and len(original_source["citation"]) <= 500
        ):
            item["source"]["citation"] = original_source["citation"]
        for message in item["messages"]:
            if (
                not isinstance(message, dict)
                or message.get("role") not in {"user", "assistant"}
                or not isinstance(message.get("content"), str)
                or len(message["content"]) > 50000
                or type(message.get("imageAttached", False)) is not bool
                or not isinstance(message.get("nearbyText", ""), str)
                or len(message.get("nearbyText", "")) > 18000
                or not isinstance(message.get("citationWarning", ""), str)
                or len(message.get("citationWarning", "")) > 1000
            ):
                raise ValueError("备份中的回答结构无效。")
            if message["role"] == "assistant":
                message["html"] = answer_html(message["content"])
                if message.get("status") == "generating":
                    message.update(
                        status="error", error="该回答在备份时尚未完成，可重新生成。"
                    )
                for reference in message.get("references", []):
                    source = source_for(
                        book,
                        {
                            "quote": reference.get("text", ""),
                            "position": reference.get("position"),
                            "context": "",
                        },
                    )
                    if (
                        type(reference.get("number")) is not int
                        or not 3 <= reference["number"] <= 32
                    ):
                        raise ValueError("备份中的来源编号无效。")
                    citation = reference.get("citation")
                    reference.update(
                        text=source["quote"],
                        position=source["position"],
                        citation=source["citation"],
                    )
                    if isinstance(citation, str) and len(citation) <= 500:
                        reference["citation"] = citation
    save(root / "library.json", collection)
    if (root / "ai-conversations.json").exists():
        save(root / "ai-conversations.json", conversations)


def recovery_manifest(root):
    return {
        path.relative_to(root).as_posix(): {
            "sha256": digest(path),
            "size": path.stat().st_size,
        }
        for path in root.rglob("*")
        if path.is_file() and allowed_path(path.relative_to(root).as_posix())
    }


def queue_stage(staging):
    backup_name = (
        "Library.before-" + time.strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]
    )
    save(
        record_path("pending-restore"),
        {
            "schema": 1,
            "stage": staging.name,
            "backup": backup_name,
            "approved": False,
            "files": recovery_manifest(staging),
        },
    )
    return {"prepared": True, "books": len(load(staging / "library.json", {})["books"])}


def prepare_restore(source):
    if (record_path("pending-restore")).exists():
        raise ValueError("已有恢复准备完成，请先重启应用或取消这次恢复。")
    if source.stat().st_size > MAX_ARCHIVE:
        raise ValueError("备份文件超过当前 2 GB 上限。")
    staging = Path(tempfile.mkdtemp(prefix=".restore-", dir=DATA.parent))
    try:
        with zipfile.ZipFile(source) as archive:
            entries = archive.infolist()
            manifest_entry = archive.getinfo("manifest.json")
            if (
                manifest_entry.file_size > 20 * 1024**2
                or len(entries) > 100000
                or sum(entry.file_size for entry in entries) > MAX_EXPANDED
            ):
                raise ValueError("备份文件规模超出当前处理上限。")
            manifest = json.loads(archive.read(manifest_entry))
            files = manifest.get("files")
            if (
                manifest.get("schema") != 1
                or manifest.get("prefix") != DATA_PREFIX
                or not isinstance(files, dict)
                or "library.json" not in files
            ):
                raise ValueError("备份版本或个人 / 演示模式与当前书库不匹配。")
            if any(
                not isinstance(value, dict)
                or type(value.get("size")) is not int
                or not 0 <= value["size"] <= MAX_EXPANDED
                or not isinstance(value.get("sha256"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", value["sha256"])
                for value in files.values()
            ):
                raise ValueError("备份中的校验信息无效。")
            if any(
                entry.flag_bits & 1
                or entry.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
                for entry in entries
            ):
                raise ValueError("暂不支持加密或使用其他压缩方式的备份。")
            expected = {"manifest.json", *("Library/" + name for name in files)}
            if (
                set(archive.namelist()) != expected
                or len(entries) != len(expected)
                or any(not allowed_path(name) for name in files)
            ):
                raise ValueError("备份文件路径不完整或不受支持。")
            required = sum(entry.file_size for entry in entries)
            if shutil.disk_usage(DATA.parent).free < required + 64 * 1024**2:
                raise ValueError("磁盘空间不足，当前书库未改动。")
            for name, expected_file in files.items():
                target = staging / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with (
                    archive.open("Library/" + name) as incoming,
                    target.open("wb") as output,
                ):
                    shutil.copyfileobj(incoming, output, 1024 * 1024)
                if target.stat().st_size != expected_file.get("size") or digest(
                    target
                ) != expected_file.get("sha256"):
                    raise ValueError("备份校验失败，当前书库未改动。")
        normalize_recovery(staging)
        return queue_stage(staging)
    except Exception as error:
        shutil.rmtree(staging, ignore_errors=True)
        if isinstance(error, (zipfile.BadZipFile, KeyError, TypeError, AttributeError)):
            raise ValueError("备份格式不完整，当前书库未改动。") from error
        raise


def apply_pending_restore():
    pending = record_path("pending-restore")
    if not pending.exists():
        return
    try:
        journal = load(pending, {})
        if not isinstance(journal, dict):
            raise ValueError()
    except (ValueError, OSError):
        pending.rename(
            pending.with_name("failed-restore-" + uuid.uuid4().hex[:8] + ".json")
        )
        save(
            record_path("restore-info"),
            {
                "restored": False,
                "message": "恢复记录无法读取，原书库保留；可重新选择备份。",
            },
        )
        return
    stage, previous = journal.get("stage", ""), journal.get("backup", "")
    if not re.fullmatch(r"\.restore-[A-Za-z0-9_-]+", stage) or not re.fullmatch(
        r"Library\.before-\d{8}T\d{6}-[0-9a-f]{8}", previous
    ):
        pending.rename(
            pending.with_name("failed-restore-" + uuid.uuid4().hex[:8] + ".json")
        )
        save(
            record_path("restore-info"),
            {
                "restored": False,
                "message": "恢复记录无效，当前书库保留；可重新选择备份。",
            },
        )
        return
    if journal.get("approved") is not True:
        return
    staging, backup_path = DATA.parent / stage, DATA.parent / previous
    try:
        candidate = staging if staging.exists() else DATA
        if recovery_manifest(candidate) != journal.get("files"):
            raise ValueError("准备恢复的文件未通过再次校验。")
        validate(candidate)
        if staging.exists():
            if DATA.exists():
                if backup_path.exists():
                    raise ValueError("恢复目录发生冲突。")
                DATA.rename(backup_path)
            staging.rename(DATA)
        pending.unlink()
        save(
            record_path("restore-info"),
            {
                "restored": True,
                "previous": previous,
                "message": "书库已恢复，恢复前的书库另行保留。",
            },
        )
    except (OSError, ValueError):
        if backup_path.exists():
            if DATA.exists():
                DATA.rename(DATA.with_name("Library.failed-" + uuid.uuid4().hex[:8]))
            backup_path.rename(DATA)
        pending.rename(
            pending.with_name("failed-restore-" + uuid.uuid4().hex[:8] + ".json")
        )
        shutil.rmtree(staging, ignore_errors=True)
        save(
            record_path("restore-info"),
            {
                "restored": False,
                "message": "恢复未完成，已保留原书库。请重新选择完整备份。",
            },
        )


def cancel_restore():
    pending = record_path("pending-restore")
    journal = load(pending, {})
    if re.fullmatch(r"\.restore-[A-Za-z0-9_-]+", journal.get("stage", "")):
        shutil.rmtree(DATA.parent / journal["stage"], ignore_errors=True)
    pending.unlink(missing_ok=True)


def approve_restore():
    pending = record_path("pending-restore")
    journal = load(pending, None)
    if not isinstance(journal, dict):
        raise ValueError("请先选择并校验备份。")
    journal["approved"] = True
    save(pending, journal)
    return {"restartRequired": True}


def prepare_previous():
    if record_path("pending-restore").exists():
        raise ValueError("请先取消已准备的恢复。")
    name = load(record_path("restore-info"), {}).get("previous", "")
    if not re.fullmatch(r"Library\.before-\d{8}T\d{6}-[0-9a-f]{8}", name):
        raise ValueError("没有找到恢复前的书库。")
    source = DATA.parent / name
    validate(source)
    staging = Path(tempfile.mkdtemp(prefix=".restore-", dir=DATA.parent))
    try:
        for path in source.rglob("*"):
            if path.is_symlink():
                raise ValueError("保留书库的资源无法验证。")
            relative = path.relative_to(source).as_posix()
            if path.is_file() and allowed_path(relative):
                target = staging / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)
        normalize_recovery(staging)
        return queue_stage(staging)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def queue_cache_cleanup():
    save(record_path("pending-cache-clear"), {"requested": True})
    return {"restartRequired": True}


def apply_cache_cleanup():
    marker = record_path("pending-cache-clear")
    if marker.exists():
        for name in ("ocr-v3", "book-index-v1", "book-index-v2", "exports"):
            shutil.rmtree(CACHE / name, ignore_errors=True)
        for directory in cloud_cache_folders():
            shutil.rmtree(directory, ignore_errors=True)
        marker.unlink()


def information():
    def size(root):
        return (
            sum(
                path.stat().st_size
                for path in root.rglob("*")
                if path.is_file() and not path.is_symlink()
            )
            if root.exists()
            else 0
        )

    cloud_bytes = sum(size(path) for path in cloud_cache_folders())
    pending = load(record_path("pending-restore"), None)
    last = load(record_path("restore-info"), {})
    return {
        "books": len(load(DATA / "library.json", {"books": []})["books"]),
        "libraryBytes": max(0, size(DATA) - cloud_bytes),
        "cacheBytes": size(CACHE) + cloud_bytes,
        "pendingRestore": bool(pending),
        "restoreApproved": bool(pending and pending.get("approved")),
        "restoreBooks": len(
            load(DATA.parent / pending["stage"] / "library.json", {"books": []})[
                "books"
            ]
        )
        if pending
        and re.fullmatch(r"\.restore-[A-Za-z0-9_-]+", pending.get("stage", ""))
        else 0,
        "pendingCacheClear": record_path("pending-cache-clear").exists(),
        "lastRestore": last,
        "previousAvailable": bool(
            last.get("previous") and (DATA.parent / last["previous"]).is_dir()
        ),
        "desktop": APP_MODE,
    }
