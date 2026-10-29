"""Bundle pinned, integrity-checked reading dependencies; no install scripts execute."""
import base64
import hashlib
import io
import json
from pathlib import Path
import tarfile
from urllib.request import urlopen

target = Path(__file__).resolve().parents[1] / "PageBetween/Web/vendor"
target.mkdir(parents=True, exist_ok=True)
packages = {"katex": "0.16.22", "marked": "15.0.12", "dompurify": "3.2.7"}
for package, version in packages.items():
    with urlopen(f"https://registry.npmjs.org/{package}/{version}", timeout=40) as response:
        metadata = json.load(response)
    with urlopen(metadata["dist"]["tarball"], timeout=60) as response:
        body = response.read(15 * 1024 * 1024)
    algorithm, digest = metadata["dist"]["integrity"].split("-", 1)
    assert algorithm == "sha512" and base64.b64encode(hashlib.sha512(body).digest()).decode() == digest
    with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as archive:
        for member in archive:
            relative = member.name.removeprefix("package/")
            chosen = relative in {"dist/katex.min.js", "dist/katex.min.css", "lib/marked.umd.js", "dist/purify.min.js", "LICENSE", "LICENSE.md"} or package == "katex" and relative.startswith("dist/fonts/")
            if not chosen or not member.isfile():
                continue
            name = relative.removeprefix("dist/").removeprefix("lib/")
            if name.startswith("LICENSE"):
                name = package + "-" + name
            path = target / name
            assert path.resolve().is_relative_to(target.resolve())
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(archive.extractfile(member).read())
    print(package, version, "verified")
