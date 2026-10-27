"""Package the ordinary macOS App; demo builds remain internal."""

import argparse
import hashlib
import json
import platform
import plistlib
import subprocess
import tempfile
import zipfile
from pathlib import Path


def package(app, destination):
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != "local.pagebetween.app":
        raise ValueError("Only the ordinary 页间 App can be publicly packaged.")
    version = info["CFBundleShortVersionString"]
    repo = Path(__file__).resolve().parents[1]
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    destination = destination or repo.parent / "releases" / ("page-between-" + version)
    destination.mkdir(parents=True, exist_ok=True)
    filename = f"page-between-{version}-macos-arm64.zip"
    target = destination / filename
    if target.exists():
        raise FileExistsError("Inspect the existing release archive before replacing it.")
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
    with tempfile.TemporaryDirectory(prefix=".package-", dir=destination) as temporary:
        staged = Path(temporary) / filename
        subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app), str(staged)], check=True)
        with zipfile.ZipFile(staged) as archive:
            if archive.testzip() is not None:
                raise ValueError("Archive integrity check failed.")
            for member in archive.namelist():
                if {".env", "services.json", "state.json", "library.json", "private-docs", "qa", ".git"}.intersection(Path(member).parts):
                    raise ValueError("Private data found in archive.")
        recovered = Path(temporary) / "extracted"
        subprocess.run(["ditto", "-x", "-k", str(staged), str(recovered)], check=True)
        restored = recovered / app.name
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(restored)], check=True)
        for name in ("Contents/Info.plist", "Contents/MacOS/page-between", "Contents/MacOS/page-between-engine", "Contents/Resources/app-v2.mjs"):
            if (app / name).read_bytes() != (restored / name).read_bytes():
                raise ValueError("Extracted App differs from the original.")
        staged.replace(target)
    with target.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    manifest = {
        "version": version, "build": info["CFBundleVersion"],
        "architecture": "arm64", "sourceCommit": commit,
        "testedMacOS": platform.mac_ver()[0],
        "artifacts": [{"file": filename, "bytes": target.stat().st_size, "sha256": digest,
                       "zipIntegrity": True, "extractedSignature": True}],
    }
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    (destination / "SHA256SUMS.txt").write_text(digest + "  " + filename + "\n")
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=Path.home() / "Library/Caches/Page Between/build/页间.app")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    package(args.app.resolve(), args.output)
