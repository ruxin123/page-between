"""Disposable export files and completed cloud intermediates, never book results."""

import re
import json
import shutil
import time

from storage import load

EXPORT_NAME = re.compile(r"[0-9a-f]{32}\.(?:epub|pbbackup)")


def discard_export(cache, name):
    if not isinstance(name, str) or not EXPORT_NAME.fullmatch(name):
        raise ValueError("导出文件标识无效。")
    if (cache / "exports").is_symlink():
        raise ValueError("导出目录无效。")
    (cache / "exports" / name).unlink(missing_ok=True)


def prune_exports(cache, now=None):
    if (cache / "exports").is_symlink():
        return
    now = time.time() if now is None else now
    files = []
    for path in (cache / "exports").glob("*"):
        if path.is_symlink() or not path.is_file() or not EXPORT_NAME.fullmatch(path.name):
            continue
        try:
            stat = path.stat()
            files.append((stat.st_mtime, path, stat.st_size))
        except FileNotFoundError:
            continue
    retained = 0
    for index, (modified, path, size) in enumerate(sorted(files, reverse=True)):
        if index >= 3 or now - modified > 3600 or (index > 0 and retained + size > 512 * 1024**2):
            path.unlink(missing_ok=True)
        else:
            retained += size


def prune_mineru_result(folder):
    canonical = folder.parent.parent / "mineru-enhancement.json"
    if folder.is_symlink() or folder.parent.is_symlink() or folder.parent.parent.is_symlink() or folder.parent.name != "mineru" or not canonical.is_file():
        return
    if load(folder / "job.json", {}).get("state") != "done":
        return
    data = load(canonical, None)
    if not isinstance(data, dict) or not data or any(not str(key).isdigit() or not isinstance(value, dict) for key, value in data.items()):
        return
    # Older or external result formats may still refer to files in the raw folder.
    if "/mineru/" + folder.name + "/" in json.dumps(data):
        return
    for path in folder.iterdir():
        if path.name == "job.json":
            continue
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)


def clear_incomplete_exports(cache):
    directory = cache / "exports"
    if directory.is_symlink():
        return
    # Called before serving requests; no export writer is active at startup.
    for path in directory.glob("*"):
        if re.fullmatch(r"[0-9a-f]{32}\.part", path.name):
            path.unlink(missing_ok=True)
        elif path.name.startswith(".epub-") and path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
