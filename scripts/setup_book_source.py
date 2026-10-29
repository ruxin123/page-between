"""Install the pinned upstream MCP component in the user's application support directory."""
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

COMMIT = "496a9290369e28c797af49caad832f7d542739f6"


def install():
    root = Path.home() / "Library/Application Support/Page Between/Book Source"
    if root.exists():
        raise ValueError("书源组件目录已存在，请先检查现有组件。")
    paths = os.pathsep.join([str(Path.home()/".local/bin"), "/opt/homebrew/bin", os.environ.get("PATH", "")])
    tools = {name:shutil.which(name, path=paths) for name in ("node", "npm", "uv", "git")}
    if not all(tools.values()):
        raise ValueError("安装书源需要 Node.js 22+、npm、uv 和 Git。")
    root.parent.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "PATH":paths, "GIT_LFS_SKIP_SMUDGE":"1", "HUSKY":"0"}
    with tempfile.TemporaryDirectory(prefix="book-source-install-", dir=root.parent) as temporary:
        stage = Path(temporary)/"component"
        def run(command):
            subprocess.run(command, cwd=stage if stage.exists() else root.parent, env=env, check=True, timeout=600, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        run([tools["git"], "clone", "--no-checkout", "https://github.com/rookslog/zlibrary-mcp.git", str(stage)])
        run([tools["git"], "checkout", COMMIT])
        run([tools["npm"], "ci", "--ignore-scripts"])
        run([tools["npm"], "run", "build"])
        run([tools["npm"], "prune", "--omit=dev", "--ignore-scripts"])
        run([tools["uv"], "sync", "--no-dev"])
        (stage/"bin").mkdir(exist_ok=True)
        (stage/"node").symlink_to(Path(tools["node"]).resolve())
        shutil.copy2(tools["uv"], stage/"bin/uv")
        # uv environments embed absolute paths: recreate after final placement.
        shutil.rmtree(stage/".venv", ignore_errors=True)
        stage.rename(root)
    try:
        subprocess.run([str(root/"bin/uv"), "sync", "--no-dev"], cwd=root, env=env, check=True, timeout=600, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        shutil.rmtree(root)
        raise
    return {"installed":True, "revision":COMMIT}


if __name__ == "__main__":
    import json
    print(json.dumps(install()))
