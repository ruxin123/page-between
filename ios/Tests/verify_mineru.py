"""Exercise production native batching and recovery without a live cloud account."""
from pathlib import Path
import argparse
import json
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--zipfoundation", type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
scratch = Path.home() / "Library/Caches/Page Between/iOS/MinerUTests"
sources = scratch / "Sources/Fixture"
sources.mkdir(parents=True, exist_ok=True)
files = [*(root / "PageBetween/Core").glob("*.swift"), root / "PageBetween/App/MobileMinerU.swift", root / "Tests/MinerUFixture.swift"]
for source in files:
    if source.name.startswith("._"):
        continue
    link = sources / source.name
    if not link.exists():
        link.symlink_to(source)
dependency = args.zipfoundation or scratch.parent / "CompileCheck/.build/checkouts/ZIPFoundation"
if not (dependency / "Package.swift").is_file():
    raise SystemExit("Resolve the Xcode package dependencies first, or pass --zipfoundation /path/to/checkout")
(scratch / "Package.swift").write_text('''// swift-tools-version:5.10
import PackageDescription
let package = Package(name:"MobileMinerUFixture",platforms:[.macOS(.v14)],dependencies:[.package(path:__ZIP_PATH__)],targets:[.executableTarget(name:"Fixture",dependencies:[.product(name:"ReadiumZIPFoundation",package:"ZIPFoundation")])])
'''.replace('__ZIP_PATH__', json.dumps(str(dependency.resolve()), ensure_ascii=False)))
subprocess.run(["swift", "run", "--package-path", str(scratch), "Fixture"], check=True)
