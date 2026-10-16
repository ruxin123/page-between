"""Copy a legacy library into an unused App data directory, preserving the source."""

import argparse
import hashlib
import json
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from storage import load, save
from paths import SUPPORT, DATA_PREFIX


def migrate(source, destination, progress=lambda message: None):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if destination.exists():
        raise ValueError(
            "目标目录已经存在，请选择尚未使用的数据目录；不会覆盖已有书库。"
        )
    if destination.is_relative_to(source) or source.is_relative_to(destination):
        raise ValueError("来源与目标目录不能互相包含。")
    library = load(source / "library.json", None)
    if not isinstance(library, dict) or not isinstance(library.get("books"), list):
        raise ValueError("找不到有效的旧版书库。")
    identifiers = [book.get("id") for book in library["books"]]
    if any(
        not isinstance(ident, str)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,80}", ident)
        for ident in identifiers
    ) or len(identifiers) != len(set(identifiers)):
        raise ValueError("书库标识不完整或重复，请先修复原书库。")
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=".page-between-migration-", dir=destination.parent)
    )
    snapshots, copied = {}, 0

    def verified_copy(original, target):
        nonlocal copied
        original, target = Path(original), Path(target)
        if original.is_symlink() or not original.is_file():
            raise ValueError("旧书库包含无法验证的资源，请保留原目录并检查。")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(original, target)
        with original.open("rb") as stream:
            before = hashlib.file_digest(stream, "sha256").digest()
        with target.open("rb") as stream:
            after = hashlib.file_digest(stream, "sha256").digest()
        if before != after:
            raise ValueError("复制校验失败，目标未启用；原书库保留。")
        copied += 1
        return str(target)

    try:
        for name in ("library.json", "state.json", "ai-conversations.json"):
            path = source / name
            if path.exists():
                snapshots[name] = path.read_bytes()
                json.loads(snapshots[name])
                verified_copy(path, staging / name)
        for index, book in enumerate(library["books"]):
            progress(f"复制与校验书籍 {index + 1} / {len(identifiers)}")
            directory = source / "books" / book["id"]
            if not directory.is_dir() or directory.is_symlink():
                raise ValueError("旧书库缺少书籍资源；原目录未改动。")
            if any(item.is_symlink() for item in directory.rglob("*")):
                raise ValueError("旧书库包含符号链接，请先确认资源完整；原目录未改动。")
            shutil.copytree(
                directory,
                staging / "books" / book["id"],
                copy_function=verified_copy,
                ignore=shutil.ignore_patterns("._*", ".DS_Store"),
            )
            enrichment = book.get("enrichmentUrl", "")
            if enrichment.startswith("/assets/"):
                url = urlsplit(enrichment)
                original = (source.parent / unquote(url.path).lstrip("/")).resolve()
                if (
                    url.query
                    or url.fragment
                    or not original.is_relative_to(source.parent / "assets")
                ):
                    raise ValueError("附加解析资源地址不受支持。")
                verified_copy(
                    original, staging / "books" / book["id"] / "enrichment.json"
                )
                book["enrichmentUrl"] = (
                    DATA_PREFIX + "/books/" + book["id"] + "/enrichment.json"
                )

            # The URL namespace stays stable even though files move outside the source tree.
            def check_urls(value):
                if isinstance(value, dict):
                    for item in value.values():
                        check_urls(item)
                elif isinstance(value, list):
                    for item in value:
                        check_urls(item)
                elif isinstance(value, str) and value.startswith(
                    ("/data/books/", "/demo-data/books/")
                ):
                    if not value.startswith(DATA_PREFIX + "/books/"):
                        raise ValueError("个人与演示书库不能混合迁移。")
                    target = (
                        staging / unquote(urlsplit(value).path[len(DATA_PREFIX) + 1 :])
                    ).resolve()
                    if (
                        not target.is_relative_to(staging / "books")
                        or not target.is_file()
                    ):
                        raise ValueError("旧书库存在缺失或越界的资源引用。")

            check_urls(book)
            save(staging / "books" / book["id"] / "book.json", book)
        if any(
            (source / name).read_bytes() != value for name, value in snapshots.items()
        ):
            raise ValueError("原书库仍在变化，请关闭旧阅读器后重试。原目录未改动。")
        save(staging / "library.json", library)
        report = {
            "schema": 1,
            "migratedAt": time.time(),
            "books": len(identifiers),
            "verifiedFiles": copied,
        }
        save(staging / "migration.json", report)
        staging.rename(destination)
        return report
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--destination", type=Path, default=SUPPORT / "Library")
    args = parser.parse_args()
    try:
        print(
            json.dumps(
                migrate(args.source, args.destination, print), ensure_ascii=False
            )
        )
    except (OSError, ValueError, shutil.Error) as error:
        parser.exit(1, str(error) + "\n")
