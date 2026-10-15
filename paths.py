"""Keep review examples separate from the reader's private library."""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEMO = "--demo" in sys.argv or os.environ.get("PAGE_BETWEEN_DEMO") == "1"
DATA = ROOT / ("demo-data" if DEMO else "data")
BOOK_ROOT = DATA / "books"
RUNTIME = Path.home() / ".cache/page-between" / ("demo" if DEMO else "native")
