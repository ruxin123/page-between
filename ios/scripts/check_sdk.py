"""Compile and link the iPhone sources without claiming a signed/installable App."""
import argparse
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--sdk", choices=["iphoneos", "iphonesimulator"], default="iphoneos")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
scratch = Path.home() / "Library/Caches/Page Between/iOS/CompileCheck"
sources = scratch / "Sources/PageBetweenMobile"
sources.mkdir(parents=True, exist_ok=True)
expected = {}
for source in (root / "PageBetween").rglob("*.swift"):
    if source.name.startswith("._"):
        continue
    if source.name in expected:
        raise SystemExit("Duplicate source basename: " + source.name)
    expected[source.name] = source.resolve()
for source in sources.iterdir():
    if source.name not in expected and source.is_symlink():
        source.unlink()
for name, source in expected.items():
    link = sources / name
    if link.is_symlink() and link.resolve() != source:
        link.unlink()
    if not link.exists():
        link.symlink_to(source)
(scratch / "Package.swift").write_text('''// swift-tools-version:5.10
import PackageDescription
let package = Package(name:"PageBetweenMobileCompile",platforms:[.iOS(.v17)],products:[.executable(name:"PageBetweenMobile",targets:["PageBetweenMobile"])],dependencies:[.package(url:"https://github.com/readium/swift-toolkit.git",exact:"3.11.1"),.package(url:"https://github.com/readium/ZIPFoundation.git",exact:"3.0.1")],targets:[.executableTarget(name:"PageBetweenMobile",dependencies:[.product(name:"ReadiumShared",package:"swift-toolkit"),.product(name:"ReadiumStreamer",package:"swift-toolkit"),.product(name:"ReadiumNavigator",package:"swift-toolkit"),.product(name:"ReadiumZIPFoundation",package:"ZIPFoundation")])])
''')
sdk = subprocess.check_output(["xcrun", "--sdk", args.sdk, "--show-sdk-path"], text=True).strip()
triple = "arm64-apple-ios17.0" + ("-simulator" if args.sdk == "iphonesimulator" else "")
subprocess.run(["swift", "build", "--package-path", str(scratch), "--triple", triple, "--sdk", sdk, "--product", "PageBetweenMobile"], check=True)
print("iOS SDK compile/link passed. Signing, resource packaging, and device execution require the Xcode project.")
