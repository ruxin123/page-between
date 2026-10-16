"""Check the exact Git index before publishing code and synthetic screenshots."""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = {
    "data",
    "demo-data",
    "qa",
    "tmp",
    "private-docs",
    ".venv",
    ".git",
    "__pycache__",
}
SECRETS = [
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"gh[pousr]_[A-Za-z0-9]{30,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{40,}"),
    re.compile(r"(?<![\w-])sk-[A-Za-z0-9_-]{30,}"),
    re.compile(r'(?:API_TOKEN|API_KEY|ACCESS_TOKEN)\s*=\s*[\'"]?[A-Za-z0-9_.-]{20,}'),
]


def findings(name, content, denied=()):
    path = Path(name)
    issues = []
    if any(part in PRIVATE or part.startswith("._") for part in path.parts):
        issues.append("private or generated directory")
    if (path.name.startswith(".env") and path.name != ".env.example") or path.suffix.lower() in {
        ".pem",
        ".key",
        ".pdf",
        ".epub",
        ".mobi",
        ".azw",
        ".azw3",
        ".cbz",
        ".docx",
    }:
        issues.append("credential or document file")
    if (
        name.startswith("assets/")
        and not name.startswith(("assets/fonts/", "assets/vendor/"))
        and name != "assets/favicon.svg"
    ):
        issues.append("unapproved asset")
    if path.suffix.lower() in {
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
    } and not name.startswith("docs/screenshots/"):
        issues.append("screenshot outside the reviewed gallery")
    if name.startswith(("assets/fonts/", "assets/vendor/")):
        return issues
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return issues
    if re.search(r'/(?:Users|Volumes|home)/[^\s\'"<>]+', text):
        issues.append("personal absolute path")
    if any(pattern.search(text) for pattern in SECRETS):
        issues.append("possible credential")
    folded = text.casefold()
    if any(
        value.casefold() in folded or value.casefold() in name.casefold()
        for value in denied
        if value
    ):
        issues.append("local exclusion term")
    return issues


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--deny-file", type=Path)
    args = parser.parse_args()
    denied = json.loads(args.deny_file.read_text()) if args.deny_file else []
    if not isinstance(denied, list) or not all(
        isinstance(value, str) for value in denied
    ):
        raise ValueError("Exclusion file must be a JSON array of strings.")
    names = (
        subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT)
        .decode()
        .split("\0")
    )
    names = [name for name in names if name]
    if not names:
        raise SystemExit("No indexed files. Stage the intended publication first.")
    failures = []
    for name in names:
        content = subprocess.check_output(["git", "show", ":" + name], cwd=ROOT)
        for issue in findings(name, content, denied):
            failures.append(f"{name}: {issue}")
    if failures:
        print("\n".join(failures))
        raise SystemExit(1)
    print(
        f"Publication check passed: {len(names)} indexed files; no blocked paths, credentials, or local exclusion terms."
    )


if __name__ == "__main__":
    main()
