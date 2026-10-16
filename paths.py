"""Keep review examples separate from the reader's private library."""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEMO = "--demo" in sys.argv or os.environ.get("PAGE_BETWEEN_DEMO") == "1"
APP_MODE = (
    bool(getattr(sys, "frozen", False)) or os.environ.get("PAGE_BETWEEN_APP") == "1"
)
PROFILE = "Review Demo" if DEMO else "Personal"
SUPPORT = Path.home() / "Library/Application Support/Page Between" / PROFILE
DATA_PREFIX = "/demo-data" if DEMO else "/data"
DATA = Path(
    os.environ.get(
        "PAGE_BETWEEN_DATA_DIR",
        str(SUPPORT / "Library" if APP_MODE else ROOT / DATA_PREFIX.lstrip("/")),
    )
)
BOOK_ROOT = DATA / "books"
CACHE = Path(
    os.environ.get(
        "PAGE_BETWEEN_CACHE_DIR",
        str(
            Path.home() / "Library/Caches/Page Between" / PROFILE
            if APP_MODE
            else DATA / "cache"
        ),
    )
)
RUNTIME = Path(
    os.environ.get(
        "PAGE_BETWEEN_NATIVE_DIR",
        str(Path.home() / ".cache/page-between" / ("demo" if DEMO else "native")),
    )
)
