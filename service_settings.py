"""Local service preferences; credential values stay in the macOS Keychain."""

import json
import os
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from paths import ROOT, RUNTIME, DEMO, SUPPORT
from storage import load, save

CONFIG = (
    Path(
        os.environ.get(
            "PAGE_BETWEEN_CONFIG_DIR",
            str(SUPPORT),
        )
    )
    / "services.json"
)
LOCK = threading.RLock()
DEFAULTS = {
    "ai": {"baseUrl": "", "model": ""},
    "mineru": {"baseUrl": "https://mineru.net/api/v4", "model": "vlm"},
}
ENV = {
    "ai": ("AI_BASE_URL", "AI_MODEL", "AI_API_KEY"),
    "mineru": ("MINERU_BASE_URL", "MINERU_MODEL_VERSION", "MINERU_API_TOKEN"),
}


class SettingsError(ValueError):
    pass


def legacy():
    values = {}
    names = {name for group in ENV.values() for name in group}
    path = ROOT / ".env"
    if path.is_file():
        for line in path.read_text().splitlines():
            name, separator, value = line.partition("=")
            if separator and name.strip() in names:
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                values[name.strip()] = value
    values.update({name: os.environ[name] for name in names if name in os.environ})
    return values


def preferences():
    try:
        data = load(CONFIG, {"schema": 1, "services": {}})
        if data.get("schema") != 1 or not isinstance(data.get("services"), dict):
            raise ValueError()
        return data
    except (OSError, ValueError, AttributeError):
        raise SettingsError("暂时无法读取服务设置，请检查本机存储。") from None


def keychain(operation, account, value=None):
    binary = RUNTIME / "service-secrets"
    if sys.platform != "darwin" or not binary.is_file():
        raise SettingsError("钥匙串组件不可用，暂时无法保存或读取凭据。")
    request = {
        "operation": operation,
        "account": account,
        "profile": "demo" if DEMO else "personal",
    }
    if value is not None:
        request["value"] = value
    try:
        result = subprocess.run(
            [str(binary)],
            input=json.dumps(request),
            text=True,
            capture_output=True,
            timeout=20,
            check=True,
        )
        response = json.loads(result.stdout)
    except (OSError, ValueError, subprocess.SubprocessError):
        raise SettingsError("钥匙串暂时无法访问，请解锁后重试。") from None
    if response.get("error"):
        raise SettingsError("钥匙串未允许本次操作，请检查系统授权后重试。")
    return response.get("value")


def effective(service, *, read_key=True):
    if not isinstance(service, str) or service not in DEFAULTS:
        raise SettingsError("没有这个服务。")
    with LOCK:
        stored = preferences()["services"].get(service)
        if stored is not None:
            config = {**DEFAULTS[service], **stored, "source": "app"}
            reference = config.get("keyRef", "")
            config["hasKey"] = bool(reference)
            config["key"] = (
                keychain("get", reference) or "" if reference and read_key else ""
            )
            if reference and read_key and not config["key"]:
                raise SettingsError("保存的凭据已不在钥匙串中，请重新填写。")
        else:
            values = legacy()
            base, model, key = (values.get(name, "").strip() for name in ENV[service])
            config = {
                "baseUrl": base or DEFAULTS[service]["baseUrl"],
                "model": model or DEFAULTS[service]["model"],
                "key": key if read_key else "",
                "hasKey": bool(key),
                "source": "environment" if base or model or key else "default",
            }
        return config


def text(value, label, limit):
    if (
        not isinstance(value, str)
        or len(value) > limit
        or any(ord(c) < 32 for c in value)
    ):
        raise SettingsError(f"{label}格式不正确。")
    return value.strip()


def validated(service, config, *, require_key=False):
    base = text(config.get("baseUrl", ""), "服务地址", 2048).rstrip("/")
    model = text(config.get("model", ""), "模型名称", 200)
    key = text(config.get("key", ""), "凭据", 4096)
    try:
        address = urlsplit(base)
        address.port
        local = address.hostname in {"127.0.0.1", "localhost", "::1"}
        if (
            not address.hostname
            or address.username
            or address.password
            or address.query
            or address.fragment
            or (address.scheme != "https" and not (local and address.scheme == "http"))
        ):
            raise ValueError()
    except ValueError:
        raise SettingsError(
            "服务地址应使用 HTTPS；本地服务可使用回环 HTTP 地址。地址中不能包含凭据或查询参数。"
        ) from None
    if not model:
        raise SettingsError("请填写模型名称。")
    if service == "mineru" and model not in {"vlm", "pipeline"}:
        raise SettingsError("请选择受支持的 MinerU 解析模型。")
    if require_key and not key and (service == "mineru" or not local):
        raise SettingsError("请在设置中填写服务凭据。")
    return {"baseUrl": base, "model": model, "key": key, "host": address.netloc}


def ai_configuration():
    config = effective("ai")
    if not config["baseUrl"] or not config["model"]:
        raise SettingsError("请先在「设置 → AI 答疑」配置模型服务。")
    result = validated("ai", config, require_key=True)
    endpoint = result["baseUrl"]
    if not endpoint.endswith("/chat/completions"):
        endpoint += "/chat/completions"
    return {
        "url": endpoint,
        "model": result["model"],
        "key": result["key"],
        "host": result["host"],
    }


def public_settings():
    services = {}
    for service in DEFAULTS:
        config = effective(service, read_key=False)
        try:
            validated(
                service,
                {**config, "key": "present" if config["hasKey"] else ""},
                require_key=True,
            )
            ready, message = True, "配置完整"
        except SettingsError as error:
            ready, message = False, str(error)
        services[service] = {
            name: config[name] for name in ("baseUrl", "model", "source", "hasKey")
        }
        services[service].update(ready=ready, message=message)
    return {
        "services": services,
        "keychainAvailable": sys.platform == "darwin"
        and (RUNTIME / "service-secrets").is_file(),
        "mineruIntegrated": True,
        "profile": "demo" if DEMO else "personal",
    }


def candidate(service, payload, *, require_key=False):
    if (
        not isinstance(service, str)
        or service not in DEFAULTS
        or not isinstance(payload, dict)
    ):
        raise SettingsError("服务配置无效。")
    if type(payload.get("removeKey", False)) is not bool:
        raise SettingsError("凭据操作无效。")
    incoming = text(payload.get("key", ""), "凭据", 4096)
    if incoming and payload.get("removeKey"):
        raise SettingsError("不能同时替换与移除凭据。")
    config = validated(service, {**payload, "key": incoming})
    old = effective(service, read_key=False)
    if not incoming and not payload.get("removeKey") and old["hasKey"]:

        def destination(base):
            url = urlsplit(base)
            return (
                url.scheme,
                url.hostname,
                url.port or (443 if url.scheme == "https" else 80),
            )

        if destination(config["baseUrl"]) != destination(old["baseUrl"]):
            raise SettingsError(
                "服务地址已更换，请为新服务重新填写凭据，或勾选移除凭据。"
            )
        config["key"] = effective(service)["key"]
    return validated(service, config, require_key=require_key)


def update(service, payload):
    with LOCK:
        config = candidate(service, payload)
        data = preferences()
        old = data["services"].get(service, {})
        value = config["key"]
        reference = old.get("keyRef", "")
        new_reference = (
            reference if not payload.get("key") and not payload.get("removeKey") else ""
        )
        if value and not new_reference:
            new_reference = service + ":" + uuid.uuid4().hex
            keychain("set", new_reference, value)
        data["services"][service] = {
            "baseUrl": config["baseUrl"],
            "model": config["model"],
            "keyRef": new_reference,
        }
        try:
            save(CONFIG, data)
        except OSError:
            if new_reference and new_reference != reference:
                try:
                    keychain("delete", new_reference)
                except SettingsError:
                    pass
            raise SettingsError(
                "服务设置未保存，请检查本机存储后重试；原配置仍保留。"
            ) from None
        cleanup_failed = False
        if reference and reference != new_reference:
            try:
                keychain("delete", reference)
            except SettingsError:
                cleanup_failed = True
        return {**public_settings(), "cleanupWarning": cleanup_failed}
