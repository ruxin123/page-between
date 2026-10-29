"""A local MCP stdio client; account secrets never enter frontend responses."""

import atexit
import json
import os
import queue
import subprocess
import threading
import time
import uuid
from pathlib import Path

import service_settings
from paths import CACHE, SUPPORT
from storage import load, save

SETTINGS = SUPPORT / "book-source.json"
RUNTIME = Path.home() / "Library/Application Support/Page Between/Book Source"
DOWNLOADS = CACHE / "book-source-downloads"
INSTALL = {"status":"idle"}
INSTALL_LOCK = threading.Lock()


def install_component():
    with INSTALL_LOCK:
        if INSTALL["status"] == "running":
            return dict(INSTALL)
        if settings()["installed"]:
            return {"status":"ready"}
        INSTALL.clear()
        INSTALL.update(status="running")
    def run():
        try:
            from scripts.setup_book_source import install
            install()
            INSTALL.update(status="ready")
        except (OSError, ValueError, subprocess.SubprocessError):
            INSTALL.update(status="error", error="组件安装未完成，请检查网络及 Node.js、uv 是否已安装后重试。")
    threading.Thread(target=run, daemon=True).start()
    return dict(INSTALL)


def settings():
    value = load(SETTINGS, {})
    return {"email": value.get("email", ""), "hasPassword": bool(value.get("keyRef")),
            "installed": (RUNTIME / "dist/index.js").is_file()}


def configure(payload):
    email, password = payload.get("email", ""), payload.get("password", "")
    if not isinstance(email, str) or not isinstance(password, str) or len(email) > 320 or len(password) > 4096 or any(ord(c) < 32 for c in email + password):
        raise ValueError("账号格式无效。")
    email = email.strip()
    if not email or "@" not in email or any(char.isspace() for char in email):
        raise ValueError("请填写有效的账号邮箱。")
    previous = load(SETTINGS, {})
    ref = previous.get("keyRef", "")
    if password:
        ref = "book-source:" + uuid.uuid4().hex
        service_settings.keychain("set", ref, password)
    elif previous.get("email") != email:
        raise ValueError("更换账号时请同时填写密码。")
    try:
        save(SETTINGS, {"email": email, "keyRef": ref})
    except OSError:
        if ref and ref != previous.get("keyRef"):
            service_settings.keychain("delete", ref)
        raise ValueError("账号设置未保存，请检查本机存储。") from None
    CLIENT.close()
    if previous.get("keyRef") and previous["keyRef"] != ref:
        service_settings.keychain("delete", previous["keyRef"])
    return settings()


class MCPClient:
    def __init__(self):
        self.lock = threading.RLock()
        self.process = None
        self.sequence = 0

    def close(self):
        with self.lock:
            if self.process:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
                self.process.stdin.close()
                self.process.stdout.close()
                self.process = None

    def _read(self, process, replies):
        try:
            while line := process.stdout.readline(4 * 1024 * 1024 + 1):
                if len(line) > 4 * 1024 * 1024:
                    break
                message = json.loads(line)
                if "id" in message:
                    replies.put(message)
        except (ValueError, OSError):
            pass
        finally:
            replies.put(None)

    def _request(self, method, params, timeout=90):
        self.sequence += 1
        ident = self.sequence
        try:
            self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": ident, "method": method, "params": params}) + "\n")
            self.process.stdin.flush()
            deadline = time.monotonic() + timeout
            while True:
                response = self.replies.get(timeout=max(.01, deadline - time.monotonic()))
                if response is None:
                    raise ValueError("书源连接已断开，请重新搜索。")
                if response.get("id") == ident:
                    if "error" in response:
                        raise ValueError("书源请求未完成，请重试。")
                    return response.get("result", {})
        except (queue.Empty, BrokenPipeError, OSError):
            self.close()
            raise ValueError("书源响应超时或连接中断，请重试。") from None

    def connect(self):
        if self.process and self.process.poll() is None:
            return
        self.close()
        entry = RUNTIME / "dist/index.js"
        node = RUNTIME / "node"
        if not entry.is_file() or not node.exists():
            raise ValueError("请先安装书源组件。")
        config = load(SETTINGS, {})
        secret = service_settings.keychain("get", config["keyRef"]) if config.get("keyRef") else ""
        DOWNLOADS.mkdir(parents=True, exist_ok=True)
        env = {**os.environ, "ZLIBRARY_EMAIL": config.get("email", ""), "ZLIBRARY_PASSWORD": secret or "",
               "ZLIBRARY_OUTPUT_ROOT": str(DOWNLOADS), "PATH": str(RUNTIME / "bin") + os.pathsep + os.environ.get("PATH", "")}
        self.process = subprocess.Popen([str(node), str(entry)], cwd=RUNTIME, env=env,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        text=True, bufsize=1)
        self.replies = queue.Queue(maxsize=64)
        threading.Thread(target=self._read, args=(self.process, self.replies), daemon=True).start()
        try:
            result = self._request("initialize", {"protocolVersion":"2025-11-25", "capabilities":{}, "clientInfo":{"name":"page-between", "version":"1"}})
            if result.get("protocolVersion") != "2025-11-25":
                raise ValueError("书源协议版本不兼容。")
            self.process.stdin.write(json.dumps({"jsonrpc":"2.0", "method":"notifications/initialized"}) + "\n")
            self.process.stdin.flush()
            names = {tool["name"] for tool in self._request("tools/list", {}).get("tools", [])}
            if not {"search", "get_book", "download", "get_limits"} <= names:
                raise ValueError("书源版本不兼容，请更新组件。")
        except Exception:
            self.close()
            raise

    def call(self, name, arguments):
        with self.lock:
            self.connect()
            result = self._request("tools/call", {"name": name, "arguments": arguments}, timeout=300 if name == "download" else 90)
            value = result.get("structuredContent")
            if value is None:
                try:
                    value = json.loads(next(item["text"] for item in result.get("content", []) if item.get("type") == "text"))
                except (StopIteration, ValueError):
                    raise ValueError("书源返回格式无效。") from None
            if not isinstance(value, dict):
                raise ValueError("书源返回格式无效。")
            if result.get("isError") or value.get("error"):
                code = value.get("error", {}).get("code", "")
                raise ValueError({"ref_unavailable":"搜索结果已过期，请重新搜索。", "credentials_missing":"请先配置书源账号。", "authentication_failed":"书源登录失败，请检查账号密码。"}.get(code, "书源暂时不可用，请检查账号或网络后重试。"))
            return value


CLIENT = MCPClient()
atexit.register(CLIENT.close)


def call(payload):
    operation = payload.get("operation")
    if operation == "search":
        if payload.get("cursor"):
            args = {"cursor": bounded(payload["cursor"], 1024)}
        else:
            args = {"query": bounded(payload.get("query"), 500), "sources":["zlibrary"], "limit":20}
            if payload.get("format"):
                fmt = payload["format"]
                if fmt not in {"epub", "pdf", "txt", "mobi", "azw3", "djvu"}:
                    raise ValueError("格式无效。")
                args["formats"] = [fmt]
        return CLIENT.call("search", args)
    if operation == "details":
        return CLIENT.call("get_book", {"ref": bounded(payload.get("ref"), 1024)})
    if operation == "limits":
        return CLIENT.call("get_limits", {"sources":["zlibrary"], "mode":"live"})
    raise ValueError("书源操作无效。")


def bounded(value, limit):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or any(ord(c) < 32 for c in value):
        raise ValueError("搜索内容或版本标识无效。")
    return value.strip()


def acquire(ref, destination):
    destination.mkdir(parents=True, exist_ok=False)
    response = CLIENT.call("download", {"ref":bounded(ref, 1024), "output_dir":str(destination)})
    raw = Path(response.get("path", ""))
    path = raw.resolve()
    if raw.is_symlink() or not path.is_relative_to(destination.resolve()) or not path.is_file() or not 0 < path.stat().st_size <= 200 * 1024 * 1024:
        raise ValueError("下载文件无效或超过 200 MB。")
    return path
