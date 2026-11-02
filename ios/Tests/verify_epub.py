"""Run the production TXT-to-EPUB writer on original fixtures and validate its archive."""
import argparse
import json
from pathlib import Path
import subprocess
import zipfile
from xml.etree import ElementTree

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--epubcheck", type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
scratch = Path.home() / "Library/Caches/Page Between/iOS/EPUBTests"
sources = scratch / "Sources/Fixture"
sources.mkdir(parents=True, exist_ok=True)
for source in [*(root / "PageBetween/Core").glob("*.swift"), root / "PageBetween/App/TextEPUB.swift"]:
    if source.name.startswith("._"):
        continue
    link = sources / source.name
    if not link.exists():
        link.symlink_to(source)
(scratch / "Package.swift").write_text('''// swift-tools-version:5.10
import PackageDescription
let package = Package(name:"MobileEPUBFixture",platforms:[.macOS(.v14)],dependencies:[.package(url:"https://github.com/readium/ZIPFoundation.git",exact:"3.0.1")],targets:[.executableTarget(name:"Fixture",dependencies:[.product(name:"ReadiumZIPFoundation",package:"ZIPFoundation")])])
''')
(sources / "Fixture.swift").write_text((root / "Tests/EPUBFixture.swift").read_text())
subprocess.run(["swift", "run", "--package-path", str(scratch), "Fixture", str(scratch)], check=True)
output = scratch / "original.epub"
with zipfile.ZipFile(output) as archive:
    entries = archive.infolist()
    assert entries[0].filename == "mimetype" and entries[0].compress_type == zipfile.ZIP_STORED
    assert archive.read("mimetype") == b"application/epub+zip"
    assert archive.testzip() is None
    for name in archive.namelist():
        if name.endswith((".xml", ".xhtml", ".opf")):
            ElementTree.fromstring(archive.read(name))
    chapter = archive.read("EPUB/chapter-0.xhtml").decode()
    assert "&lt;angles&gt; &amp; symbols 🪶" in chapter
    assert "第一章 原创样本" in chapter
    assert "第二章 继续阅读" in archive.read("EPUB/nav.xhtml").decode()
with zipfile.ZipFile(scratch / "unparsed.epub") as archive:
    nav = ElementTree.fromstring(archive.read("EPUB/nav.xhtml"))
    assert len(nav.findall(".//{http://www.w3.org/1999/xhtml}a")) == 1
    body = archive.read("EPUB/chapter-0.xhtml").decode()
    assert "第一章 原创样本" in body and "第二章 继续阅读" in body
with zipfile.ZipFile(scratch / "fb2.epub") as archive:
    assert archive.testzip() is None
    for name in archive.namelist():
        if name.endswith((".xml", ".xhtml", ".opf", ".svg")):
            ElementTree.fromstring(archive.read(name))
    nav = ElementTree.fromstring(archive.read("EPUB/nav.xhtml"))
    assert len(nav.findall(".//{http://www.w3.org/1999/xhtml}a")) == 3
    assert b"Synthetic Reader" in archive.read("EPUB/package.opf")
    targets = {}
    for name in ["EPUB/chapter-0.xhtml", "EPUB/chapter-1.xhtml"]:
        root_node = ElementTree.fromstring(archive.read(name))
        targets[name] = {node.attrib["id"] for node in root_node.iter() if "id" in node.attrib}
    for name in targets:
        root_node = ElementTree.fromstring(archive.read(name))
        for link in root_node.findall(".//{http://www.w3.org/1999/xhtml}a"):
            file, fragment = link.attrib["href"].split("#")
            assert fragment in targets["EPUB/" + file]
if args.epubcheck:
    for name in ["original.epub", "unparsed.epub", "fb2.epub"]:
        subprocess.run(["java", "-jar", str(args.epubcheck.resolve()), str(scratch / name)], check=True)
print(json.dumps({"productionWriter": True, "repeatConversion": True, "epubPackaging": True, "xmlValid": True, "unicodePreserved": True, "epubcheck": bool(args.epubcheck)}))
