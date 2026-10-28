"""Build a self-contained macOS App without private books, configuration or history."""

import argparse
import importlib.metadata
import json
import platform
import plistlib
import shutil
import ssl
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = Path.home() / "Library/Caches/Page Between/build"


def run(command, **kwargs):
    subprocess.run([str(value) for value in command], check=True, **kwargs)


def build(demo=False):
    if sys.platform != "darwin":
        raise SystemExit("Build the macOS App on macOS.")
    importlib.metadata.version("pyinstaller")
    tools = {
        name: shutil.which(name) for name in ("swiftc", "node", "pandoc", "tesseract")
    }
    if not all(tools.values()):
        raise SystemExit(
            "The build environment needs Swift, Node.js, Pandoc and Tesseract."
        )
    destination = BUILD / ("页间演示.app" if demo else "页间.app")
    executable = str(destination / "Contents/MacOS/page-between")
    commands = subprocess.check_output(
        ["ps", "-axo", "command="], text=True
    ).splitlines()
    if any(
        command.strip() == executable or command.strip().startswith(executable + " ")
        for command in commands
    ):
        raise SystemExit(
            "Close the running App from this build directory before replacing its bundle."
        )
    BUILD.mkdir(parents=True, exist_ok=True)
    resources = BUILD / "resources"
    if resources.exists():
        shutil.rmtree(resources)
    resources.mkdir()
    files = (
        subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT)
        .decode()
        .split("\0")
    )
    entrypoints = {
        "index.html",
        "app-v2.mjs",
        "core.mjs",
        "page-layout.mjs",
        "layout.css",
        "epub-reader.css",
        "parse_text.mjs",
        "normalize-headings.lua",
        "normalize-math.lua",
        "scripts/demo-enhancement.json",
        "assets/favicon.svg",
        "THIRD_PARTY_NOTICES.md",
        "FONTS.md",
    }
    for name in files:
        if name in entrypoints or name.startswith(
            ("ui/", "assets/fonts/", "assets/vendor/")
        ):
            target = resources / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
    native = BUILD / "native"
    native.mkdir(exist_ok=True)
    for source, binary in (
        ("OCR.swift", "ocr-page"),
        ("Secrets.swift", "service-secrets"),
    ):
        run(
            [
                tools["swiftc"],
                "-O",
                "-swift-version",
                "5",
                ROOT / "native" / source,
                "-o",
                native / binary,
            ]
        )
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--windowed",
        "--name",
        "page-between-engine",
        "--log-level",
        "WARN",
        "--distpath",
        BUILD / "dist",
        "--workpath",
        BUILD / "work",
        "--specpath",
        BUILD / "spec",
        "--add-data",
        str(resources) + ":.",
    ]
    for name in ("node", "pandoc", "tesseract"):
        command += ["--add-binary", str(Path(tools[name]).resolve()) + ":bin"]
    # Some bundled Python runtimes load this companion when creating any SSL context.
    # Preserve that runtime policy in the frozen app as well.
    ssl_companion = Path(ssl.__file__).with_name("codex-rejected-cas.pem")
    if ssl_companion.is_file():
        command += ["--add-data", str(ssl_companion) + ":."]
    tessdata = (
        Path(tools["tesseract"]).resolve().parents[1] / "share/tessdata/eng.traineddata"
    )
    if not tessdata.exists():
        tessdata = (
            Path(tools["tesseract"]).parent.parent / "share/tessdata/eng.traineddata"
        )
    if not tessdata.exists():
        raise SystemExit("English Tesseract language data was not found.")
    command += ["--add-data", str(tessdata.resolve()) + ":tessdata", ROOT / "server.py"]
    run(command, cwd=ROOT)
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(BUILD / "dist/page-between-engine.app", destination, symlinks=True)
    contents = destination / "Contents"
    (contents / "Helpers").mkdir(exist_ok=True)
    shutil.copytree(native, contents / "Helpers/native")
    run(
        [
            tools["swiftc"],
            "-O",
            "-swift-version",
            "5",
            "-parse-as-library",
            ROOT / "native/App.swift",
            ROOT / "native/Palm.swift",
            ROOT / "native/Translation.swift",
            ROOT / "native/BookSource.swift",
            "-o",
            contents / "MacOS/page-between",
        ]
    )
    run([tools["swiftc"], ROOT / "native/Icon.swift", "-o", BUILD / "draw-icon"])
    run([BUILD / "draw-icon", BUILD / "icon.png"])
    iconset = BUILD / "App.iconset"
    iconset.mkdir(exist_ok=True)
    for pixels in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            name = f"icon_{pixels}x{pixels}" + ("@2x" if scale == 2 else "") + ".png"
            run(
                [
                    "sips",
                    "-z",
                    pixels * scale,
                    pixels * scale,
                    BUILD / "icon.png",
                    "--out",
                    iconset / name,
                ],
                stdout=subprocess.DEVNULL,
            )
    run(["iconutil", "-c", "icns", iconset, "-o", contents / "Resources/App.icns"])
    info = {
        "CFBundleIdentifier": "local.pagebetween.app" + (".demo" if demo else ""),
        "CFBundleName": "页间演示" if demo else "页间",
        "CFBundleDisplayName": "页间演示" if demo else "页间",
        "CFBundleExecutable": "page-between",
        "CFBundlePackageType": "APPL",
        "CFBundleIconFile": "App.icns",
        "CFBundleShortVersionString": "0.5.24",
        "CFBundleVersion": "248",
        "NSHighResolutionCapable": True,
        "PageBetweenDemo": demo,
        "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
        "CFBundleDocumentTypes": [
            {
                "CFBundleTypeName": "电子书",
                "CFBundleTypeRole": "Viewer",
                "LSHandlerRank": "Alternate",
                "CFBundleTypeExtensions": [
                    "epub",
                    "pdf",
                    "txt",
                    "mobi",
                    "azw",
                    "azw3",
                    "fb2",
                    "md",
                    "markdown",
                    "html",
                    "htm",
                    "docx",
                    "odt",
                    "rtf",
                    "cbz",
                ],
            }
        ],
    }
    (contents / "Info.plist").write_bytes(plistlib.dumps(info))
    notices = contents / "Resources/Notices"
    notices.mkdir()
    for name in ("THIRD_PARTY_NOTICES.md", "FONTS.md"):
        shutil.copyfile(ROOT / name, notices / name)
    licenses = []
    for distribution in importlib.metadata.distributions():
        for file in distribution.files or []:
            if ".dist-info/" in str(file) and any(
                part.lower() in {"licenses", "license", "licence", "copying"}
                for part in Path(file).parts
            ):
                path = distribution.locate_file(file)
                if path.is_file():
                    target = notices / "python" / str(file)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(path, target)
        licenses.append(
            {"name": distribution.metadata["Name"], "version": distribution.version}
        )
    (notices / "python-packages.json").write_text(
        json.dumps(licenses, indent=2), encoding="utf-8"
    )
    run(["codesign", "--force", "--deep", "--sign", "-", destination])
    run(["codesign", "--verify", "--deep", "--strict", destination])
    print(
        json.dumps(
            {"app": str(destination), "architecture": platform.machine(), "demo": demo},
            ensure_ascii=False,
        ),
        flush=True,
    )
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo", action="store_true")
    build(parser.parse_args().demo)
