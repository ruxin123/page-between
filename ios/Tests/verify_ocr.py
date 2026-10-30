"""Exercise the production Vision/PDFKit OCR worker on an original scanned fixture."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
scratch = Path.home() / "Library/Caches/Page Between/iOS/OCRTests"
sources = scratch / "Sources/Fixture"
sources.mkdir(parents=True, exist_ok=True)
files = [*(root / "PageBetween/Core").glob("*.swift"), root / "PageBetween/App/PDFTextPreparation.swift", root / "Tests/PDFOCRFixture.swift"]
for source in files:
    if source.name.startswith("._"):
        continue
    link = sources / source.name
    if not link.exists():
        link.symlink_to(source)
(scratch / "Package.swift").write_text('''// swift-tools-version:5.10
import PackageDescription
let package = Package(name:"MobileOCRFixture",platforms:[.macOS(.v14)],targets:[.executableTarget(name:"Fixture")])
''')
subprocess.run(["swift", "run", "--package-path", str(scratch), "Fixture", str(scratch)], check=True)
