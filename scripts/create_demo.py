"""Generate original, fictional material for screenshots and independent reviews."""

import json
import textwrap
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

from book_import import import_book
from paths import DATA, DEMO


PARAGRAPHS = [
    "清晨，门廊外落着一层薄雾。她把纸页夹进笔记本，准备在出发前再读一会儿。窗边的光缓缓移动，落在尚未读完的那一行上。",
    "街角的小店刚刚开门，杯子与木桌轻轻相碰。她没有急着翻到下一页，而是停下来，想一想刚刚读到的那句话。",
    "有些问题适合立即寻找答案，有些问题可以先留在页边。她在笔记里画了一条短线，给这个念头留了一个位置。",
    "午后的风吹进走廊，远处传来零散的脚步声。一本书不需要一次读完，重要的是下一次打开时，还能找到刚才停留的地方。",
    "她沿着小路向河边走去，途中想起几天前记下的一个词。它并不复杂，却在新的句子里显出了不同的意思。",
    "傍晚，屋里的灯亮了起来。她把白天的想法重新整理，发现先前不明白的地方，已经能够与另一段文字接在一起。",
]
ENGLISH = [
    "A quiet room gives a paragraph space to unfold. The reader follows one idea, pauses at a sentence, and returns to a note made earlier.",
    "A useful explanation connects a new example with something already understood. It leaves enough room to ask another question.",
    "Reading moves between detail and context. A short definition can be helpful, while the surrounding pages explain why it matters.",
    "The afternoon light changes slowly across the desk. The page remains clear, and the next passage is only a small movement away.",
]


def cover_svg(label, background, accent):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="480" height="680" viewBox="0 0 480 680">
<rect width="480" height="680" fill="{background}"/>
<rect x="34" y="34" width="412" height="612" rx="3" fill="none" stroke="{accent}" stroke-opacity=".32"/>
<path d="M78 470 Q240 190 402 470 M98 490 Q240 255 382 490" fill="none" stroke="{accent}" stroke-width="1.5" stroke-opacity=".45"/>
<circle cx="240" cy="250" r="70" fill="none" stroke="{accent}" stroke-opacity=".3"/>
<text x="240" y="135" text-anchor="middle" fill="{accent}" font-family="serif" font-size="36" letter-spacing="8">{escape(label)}</text>
<text x="240" y="580" text-anchor="middle" fill="{accent}" font-family="sans-serif" font-size="13" letter-spacing="4">READING SAMPLE</text>
</svg>'''


def make_epub(path, label="示例书籍 A", language="zh"):
    english = language == "en"
    paragraphs = ENGLISH if english else PARAGRAPHS
    files = {
        "META-INF/container.xml": '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
        "OPS/style.css": "body{font-family:serif}h1{font-size:1.45em;font-weight:normal;margin:0 0 1.4em}p{margin:0 0 1em;text-align:justify}a{color:#537d68}figure{margin:1.4em 0}figcaption{font-size:.65em;text-align:center;opacity:.6}table{border-collapse:collapse;width:100%;font-size:.8em}td,th{padding:.6em;border-bottom:1px solid #aab9ad}math{margin:1.1em auto}",
        "OPS/cover.svg": cover_svg(
            "EPUB · D" if english else "EPUB · A",
            "#526c61" if not english else "#717b91",
            "#f1ede0",
        ),
        "OPS/figure.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 120"><rect width="640" height="120" fill="#edf2eb"/><path d="M0 89 Q160 12 320 75 T640 47" fill="none" stroke="#8eab98" stroke-width="2"/><path d="M0 110 Q160 45 320 100 T640 70" fill="none" stroke="#c2d0c4" stroke-width="2"/><circle cx="500" cy="36" r="14" fill="#d9dfc3"/></svg>',
        "OPS/cover.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title></head><body><img src="cover.svg" alt="原创演示封面" style="display:block;width:70%;margin:auto"/></body></html>',
        "OPS/notes.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>示例注释</title><link rel="stylesheet" href="style.css"/></head><body><h1>原书注释示例</h1><p id="note-1">这是自编的注释，用于演示从正文进入补充内容，再返回原阅读位置。</p><a href="chapter-1.xhtml#start">返回正文</a></body></html>',
    }
    titles = (
        [
            "A Quiet Beginning",
            "Following an Idea",
            "Notes in the Margin",
            "A New Example",
            "Looking Back",
            "The Next Page",
        ]
        if english
        else [
            "第一章 清晨",
            "第二章 窗边",
            "第三章 片刻",
            "第四章 小路",
            "第五章 灯下",
            "第六章 归来",
        ]
    )
    nav = []
    for index, title in enumerate(titles, 1):
        body = "".join(
            f"<p>{escape(paragraphs[(step + index - 1) % len(paragraphs)])}</p>"
            for step in range(24)
        )
        if index == 1:
            body = (
                '<figure><img src="figure.svg" alt="原创抽象示例插图"/><figcaption>Illustration · original demo artwork</figcaption></figure>'
                + body
            )
            body += '<p><a href="notes.xhtml#note-1">查看注释示例</a></p>'
        if index == 2:
            body = (
                '<p>下面的公式和表格是自编的排版示例。</p><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><msup><mi>y</mi><mn>2</mn></msup><mo>=</mo><msup><mi>r</mi><mn>2</mn></msup></math><table><tr><th>x</th><th>f(x)</th></tr><tr><td>0</td><td>0</td></tr><tr><td>1</td><td>1</td></tr><tr><td>2</td><td>4</td></tr></table>'
                + body
            )
        files[f"OPS/chapter-{index}.xhtml"] = (
            f'<html xmlns="http://www.w3.org/1999/xhtml" lang="{language}"><head><title>{escape(title)}</title><link rel="stylesheet" href="style.css"/></head><body><h1 id="start">{escape(title)}</h1>{body}</body></html>'
        )
        nav.append(
            f'<li><a href="chapter-{index}.xhtml#start">{escape(title)}</a></li>'
        )
    files["OPS/nav.xhtml"] = (
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol>'
        + "".join(nav)
        + "</ol></nav></body></html>"
    )
    manifest = "".join(
        f'<item id="chapter-{i}" href="chapter-{i}.xhtml" media-type="application/xhtml+xml"/>'
        for i in range(1, 7)
    )
    spine = "".join(f'<itemref idref="chapter-{i}"/>' for i in range(1, 7))
    files["OPS/book.opf"] = (
        f'<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">page-between-original-demo-{language}</dc:identifier><dc:title>{escape(label)}</dc:title><dc:creator>演示作者</dc:creator><dc:language>{language}</dc:language></metadata><manifest><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="cover-image" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/><item id="figure" href="figure.svg" media-type="image/svg+xml"/><item id="style" href="style.css" media-type="text/css"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/>{manifest}</manifest><spine><itemref idref="cover"/>{spine}<itemref idref="notes" linear="no"/></spine></package>'
    )
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED
        )
        for name, value in files.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            archive.writestr(info, value, compress_type=zipfile.ZIP_DEFLATED)


def make_pdf(path):
    from reportlab.pdfgen import canvas
    from reportlab.lib.colors import HexColor

    output = canvas.Canvas(str(path), pagesize=(540, 740), invariant=1)
    output.setTitle("Original review sample C")
    output.setAuthor("Page Between demo")
    sections = [
        "1. Concepts and examples",
        "2. A simple relation",
        "3. Reading a table",
        "4. Return to an earlier idea",
    ]
    for index, title in enumerate(sections, 1):
        output.bookmarkPage(f"section-{index}")
        output.addOutlineEntry(title, f"section-{index}", level=0)
        output.setStrokeColor(HexColor("#a9b7ae"))
        output.line(58, 686, 482, 686)
        output.setFillColor(HexColor("#294137"))
        output.setFont("Times-Bold", 19)
        output.drawString(58, 646, title)
        output.setFont("Times-Roman", 12)
        text = output.beginText(58, 610)
        text.setLeading(19)
        for paragraph in [
            "This page is original demonstration material. It is included so that reviewers can inspect a fixed page, select its text, and navigate its outline without using a personal book.",
            "Definition 1.1. A relation describes how one quantity is associated with another. In the following example, the rule takes a number x and returns its square.",
            "Example. For x = 0, 1, 2, the corresponding values are 0, 1, 4. The table and drawing below present the same small example in two forms.",
        ]:
            for line in textwrap.wrap(paragraph, 76):
                text.textLine(line)
            text.textLine("")
        output.drawText(text)
        output.setFont("Times-Italic", 18)
        output.drawCentredString(270, 335, "f(x) = x squared")
        output.setFont("Times-Roman", 12)
        for row, pair in enumerate([("x", "f(x)"), ("0", "0"), ("1", "1"), ("2", "4")]):
            y = 287 - row * 28
            output.drawString(92, y, pair[0])
            output.drawString(160, y, pair[1])
            output.line(78, y - 9, 215, y - 9)
        output.line(300, 200, 467, 200)
        output.line(309, 190, 309, 310)
        curve = output.beginPath()
        curve.moveTo(309, 200)
        for step in range(1, 101):
            curve.lineTo(309 + step * 1.45, 200 + step * step * 0.01)
        output.setStrokeColor(HexColor("#638671"))
        output.drawPath(curve)
        output.setFont("Times-Roman", 10)
        output.drawCentredString(270, 46, str(index))
        output.showPage()
    output.save()


def make_scan(source, destination):
    import pypdfium2 as pdfium
    from reportlab.pdfgen import canvas
    from reportlab.lib.utils import ImageReader

    document = pdfium.PdfDocument(str(source))
    output = canvas.Canvas(str(destination), pagesize=(540, 740), invariant=1)
    output.setTitle("Original scanned review sample E")
    output.setAuthor("Page Between demo")
    for page in document:
        image = page.render(scale=1.8).to_pil()
        output.drawImage(ImageReader(image), 0, 0, width=540, height=740)
        output.showPage()
        page.close()
    output.save()
    document.close()


def prepare():
    if not DEMO:
        raise ValueError("Use server.py --demo to create fictional review material.")
    DATA.mkdir(parents=True, exist_ok=True)
    source = DATA / "sources"
    source.mkdir(exist_ok=True)
    make_epub(source / "sample-a.epub")
    make_epub(source / "sample-d.epub", "Example D", "en")
    novel = []
    for index in range(1, 9):
        if index in {1, 5}:
            novel.append(f"第{1 if index == 1 else 2}卷 示例分卷")
        novel.extend(
            [
                f"第{index}章 示例章节",
                "\n\n".join(
                    PARAGRAPHS[(step + index) % len(PARAGRAPHS)] for step in range(24)
                ),
            ]
        )
    (source / "sample-b.txt").write_text("\n".join(novel), encoding="utf-8")
    make_pdf(source / "sample-c.pdf")
    make_scan(source / "sample-c.pdf", source / "sample-e.pdf")
    books = []
    for ident, name, title, shelf in [
        ("demo-a", "sample-a.epub", "示例书籍 A", "小说"),
        ("demo-b", "sample-b.txt", "示例文本 B", "小说"),
        ("demo-c", "sample-c.pdf", "示例教材 C", "学习"),
        ("demo-d", "sample-d.epub", "Example D", "小说"),
        ("demo-e", "sample-e.pdf", "示例扫描件 E", "学习"),
    ]:
        book = import_book(source / name, ident=ident, title=title, shelf=shelf)
        book["author"] = "演示作者" if ident != "demo-d" else "Demo author"
        book["onShelf"] = ident in {"demo-a", "demo-c"}
        if book["type"] == "pdf":
            book["language"] = "en"
        if not book.get("cover"):
            cover = DATA / "books" / ident / "cover.svg"
            cover.write_text(
                cover_svg(
                    "TXT · B"
                    if book["type"] == "txt"
                    else "PDF · " + ident[-1].upper(),
                    "#758796" if book["type"] == "pdf" else "#8b8473",
                    "#f3f0e6",
                ),
                encoding="utf-8",
            )
            book["cover"] = "/" + cover.relative_to(DATA.parent).as_posix()
        (DATA / "books" / ident / "book.json").write_text(
            json.dumps(book, ensure_ascii=False), encoding="utf-8"
        )
        books.append(book)
    (DATA / "library.json").write_text(
        json.dumps({"books": books, "jobs": []}, ensure_ascii=False), encoding="utf-8"
    )
    (DATA / "state.json").write_text(
        json.dumps(
            {
                "schema": 2,
                "revision": 1,
                "prefs": {},
                "positions": {
                    "demo-a": {
                        "index": 2,
                        "page": 0,
                        "top": 0,
                        "progress": 0.12,
                        "updatedAt": 1,
                    }
                },
                "bookmarks": [],
                "lastBook": "demo-a",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
