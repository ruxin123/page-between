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
(sources / "Fixture.swift").write_text('''import Foundation
@main struct Fixture {
 static func main() async throws {
  let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
  let original = folder.appendingPathComponent("original.txt"), output = folder.appendingPathComponent("original.epub")
  try Data("第一章 原创样本\\n\\nAn original paragraph with <angles> & symbols 🪶.\\n\\n第二章 继续阅读\\n\\nThis is another original paragraph.".utf8).write(to: original)
  try await TextEPUB.create(original: original, title: "Original mobile reading sample", destination: output)
  try await TextEPUB.create(original: original, title: "Original mobile reading sample", destination: output)
 }
}
''')
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
if args.epubcheck:
    subprocess.run(["java", "-jar", str(args.epubcheck.resolve()), str(output)], check=True)
print(json.dumps({"productionWriter": True, "repeatConversion": True, "epubPackaging": True, "xmlValid": True, "unicodePreserved": True, "epubcheck": bool(args.epubcheck)}))
