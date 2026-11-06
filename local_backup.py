"""Opt-in, bounded local snapshots. Service settings are outside the backup input."""
import threading
import re
import time
from pathlib import Path

from paths import DATA, CACHE
from storage import load, save
import library_data
import book_margins

LOCK = threading.RLock()
INTERVALS = {"off": 0, "daily": 86400, "weekly": 7 * 86400}


def configuration():
    return load(DATA.parent / (DATA.name + "-backup.json"), {"frequency": "off"})


def configure(value):
    if value not in INTERVALS:
        raise ValueError("备份周期无效。")
    with LOCK:
        result = configuration()
        result["frequency"] = value
        save(DATA.parent / (DATA.name + "-backup.json"), result)
        return result


def completed(kind, name):
    with LOCK:
        result = configuration()
        result["lastSuccess"] = time.time()
        result["lastKind"] = kind
        result["lastName"] = name
        if kind == "auto":
            result["lastAuto"] = result["lastSuccess"]
        result.pop("error", None)
        save(DATA.parent / (DATA.name + "-backup.json"), result)


def automatic(snapshot):
    with LOCK:
        config = configuration()
        interval = INTERVALS.get(config.get("frequency"), 0)
        now = time.time()
        if not interval or now - config.get("lastAuto", 0) < interval or now - config.get("lastAttempt", 0) < 3600:
            return False
        config["lastAttempt"] = now
        save(DATA.parent / (DATA.name + "-backup.json"), config)
        try:
            with book_margins.LOCK:
                result = library_data.backup(snapshot())
            directory = DATA.parent / "Backups"
            if directory.is_symlink():
                raise ValueError("自动备份目录不可用。")
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            target = directory / ("页间-" + time.strftime("%Y%m%d-%H%M%S") + "-" + result["id"])
            (CACHE / "exports" / result["id"]).replace(target)
            completed("auto", target.name)
            backups = sorted((path for path in directory.glob("页间-*.pbbackup") if re.fullmatch(r"页间-\d{8}-\d{6}-[0-9a-f]{32}\.pbbackup", path.name) and not path.is_symlink()), key=lambda path: path.stat().st_mtime, reverse=True)
            for old in backups[3:]:
                if not old.is_symlink(): old.unlink()
            return True
        except (ValueError, OSError) as error:
            config = configuration()
            config["error"] = "自动备份未完成，请检查存储空间或手动备份。"
            save(DATA.parent / (DATA.name + "-backup.json"), config)
            return False
