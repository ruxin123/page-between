"""Add an original three-page PDF and controlled extraction to an isolated test library."""

import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reportlab.pdfgen import canvas
from book_import import BOOK_ROOT, import_book, url_for
from paths import DATA
from storage import load, save


def create():
    samples = DATA / "sources"
    samples.mkdir(parents=True, exist_ok=True)
    source = samples / "original-rendering-contract.pdf"
    c = canvas.Canvas(str(source), pagesize=(600, 800), invariant=1)
    c.setTitle("Original rendering contract")
    c.setAuthor("Page Between original sample")
    for page in [1, 2]:
        c.setFont("Times-Roman", 16)
        c.drawString(60, 720, "First original page" if page == 1 else "Second original page")
        c.setFont("Times-Roman", 12)
        c.drawString(60, 680, "A line before the formula.")
        c.setFont("Times-Roman", 18)
        if page == 1:
            c.drawString(120, 610, "x")
            c.setFont("Times-Roman", 10)
            c.drawString(130, 620, "2")
            c.setFont("Times-Roman", 18)
            c.drawString(140, 610, "+ 1")
            c.setFont("Times-Roman", 12)
            c.drawString(60, 550, "The selection continues on the next page.")
        else:
            c.drawString(130, 620, "a")
            c.line(120, 614, 150, 614)
            c.drawString(130, 594, "b")
            c.setFont("Times-Roman", 12)
            for y, row in zip([500, 478, 456], [("name", "value"), ("first", "1"), ("second", "2")]):
                c.drawString(60, y, row[0])
                c.drawString(260, y, row[1])
        c.showPage()
    c.showPage()  # An empty final page must not extend a selected text range.
    c.save()
    book = import_book(source, enabled=True)
    book.update(title="Original rendering contract", language="en", processing="ready")
    pages = {}
    for page in [1, 2]:
        blocks = [
            {"type": "text", "text": "First original page" if page == 1 else "Second original page", "bbox": [.08, .08, .9, .12]},
            {"type": "text", "text": "A line before the formula.", "bbox": [.08, .13, .9, .17]},
            {"type": "equation", "text": "x^2+1" if page == 1 else r"\frac{a}{b}", "bbox": [.18, .20, .4, .28]},
        ]
        if page == 1:
            blocks.append({"type": "text", "text": "The selection continues on the next page.", "bbox": [.08, .28, .9, .33]})
        else:
            blocks.append({"type": "table", "text": "name\tvalue\nfirst\t1\nsecond\t2", "bbox": [.08, .36, .6, .445], "tableHtml": "<table><tr><th>name</th><th>value</th></tr><tr><td>first</td><td>1</td></tr><tr><td>second</td><td>2</td></tr></table>"})
        for order, block in enumerate(blocks):
            block.update(id=f"p{page}-b{order}", order=order)
        pages[str(page)] = {"blocks": blocks, "engine": "controlled-original", "size": [600, 800]}
    pages["3"] = {"blocks": [], "engine": "controlled-original", "size": [600, 800]}
    enhancement = BOOK_ROOT / book["id"] / "rendering-contract.json"
    save(enhancement, pages)
    book.update(enrichmentUrl=url_for(enhancement), enhancementRevision=1, enhancedPages=[1, 2, 3])
    library = load(DATA / "library.json", {"books": [], "jobs": []})
    library["books"] = [existing for existing in library["books"] if existing["id"] != book["id"]] + [book]
    save(DATA / "library.json", library)
    save(DATA / "rendering-sample.json", {"book": book["id"], "controlledExtraction": True})
    print(json.dumps({"book": book["id"], "pages": 3, "controlledExtraction": True}))


if __name__ == "__main__":
    if "PAGE_BETWEEN_DATA_DIR" not in __import__("os").environ:
        raise SystemExit("Set PAGE_BETWEEN_DATA_DIR to an isolated test library.")
    create()
