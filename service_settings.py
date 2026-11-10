"""Service preferences and credentials in the App's private configuration directory."""

import json
import ipaddress
import os
import subprocess
import sys
import threading
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
    "ai": {"baseUrl": "", "model": "", "supportsImages": False, "customPrompt": ""},
    "translation": {"baseUrl": "", "model": "", "provider": "ai", "useChatModel": True, "customPrompt": ""},
    "mineru": {"baseUrl": "https://mineru.net/api/v4", "model": "vlm"},
}
ENV = {
    "ai": ("AI_BASE_URL", "AI_MODEL", "AI_API_KEY"),
    "translation": ("TRANSLATION_BASE_URL", "TRANSLATION_MODEL", "TRANSLATION_API_KEY"),
    "mineru": ("MINERU_BASE_URL", "MINERU_MODEL_VERSION", "MINERU_API_TOKEN"),
}


class SettingsError(ValueError):
    pass


def local_host(host):
    if not host:
        return False
    if host in {"localhost", "::1"} or host.endswith(".local"):
        return True
    try:
        address = ipaddress.IPv4Address(host)
    except ipaddress.AddressValueError:
        return False
    return any(address in ipaddress.IPv4Network(network) for network in ("127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


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


def legacy_key(account):
    """Read old credentials once without requesting system authentication."""
    binary = RUNTIME / "service-secrets"
    if sys.platform != "darwin" or not binary.is_file():
        raise SettingsError("旧凭据无法自动迁移，请在设置中重新填写。")
    request = {
        "operation": "get",
        "account": account,
        "profile": "demo" if DEMO else "personal",
    }
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
        raise SettingsError("旧凭据无法自动迁移，请在设置中重新填写。") from None
    if response.get("error"):
        raise SettingsError("旧凭据无法自动迁移，请在设置中重新填写。")
    return response.get("value")


def effective(service, *, read_key=True):
    if not isinstance(service, str) or service not in DEFAULTS:
        raise SettingsError("没有这个服务。")
    with LOCK:
        stored = preferences()["services"].get(service)
        if stored is not None:
            config = {**DEFAULTS[service], **stored, "source": "app"}
            reference = config.get("keyRef", "")
            if reference and "key" not in stored and read_key:
                value = legacy_key(reference)
                if not value:
                    raise SettingsError("旧凭据无法自动迁移，请在设置中重新填写。")
                data = preferences()
                migrated = {**stored, "key": value}
                migrated.pop("keyRef", None)
                data["services"][service] = migrated
                save(CONFIG, data)
                config = {**DEFAULTS[service], **migrated, "source": "app"}
            config["hasKey"] = bool(config.get("key") or reference)
            config["key"] = config.get("key", "") if read_key else ""
        else:
            values = legacy()
            base, model, key = (values.get(name, "").strip() for name in ENV[service])
            config = {
                **DEFAULTS[service],
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
    extra = {}
    if service in {"ai", "translation"}:
        prompt = config.get("customPrompt", "")
        if not isinstance(prompt, str) or len(prompt) > 4000 or any(ord(c) < 32 and c not in "\n\r\t" for c in prompt):
            raise SettingsError("自定义提示词请控制在 4000 字以内。")
        extra["customPrompt"] = prompt.strip()
    if service == "translation":
        if not isinstance(config.get("provider", "ai"), str) or config.get("provider", "ai") not in {"ai", "google"} or type(config.get("useChatModel", True)) is not bool:
            raise SettingsError("翻译服务选项无效。")
        extra.update(provider=config.get("provider", "ai"), useChatModel=config.get("useChatModel", True))
        if not base and not model and (extra["useChatModel"] or extra["provider"] == "google"):
            return {"baseUrl": "", "model": "", "key": key, "host": "", **extra}
    try:
        address = urlsplit(base)
        address.port
        local = local_host(address.hostname)
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
            "请使用 HTTPS 或本机／局域网 HTTP 地址，地址不能包含凭据或查询参数。"
        ) from None
    if not model:
        raise SettingsError("请填写模型名称。")
    if service == "mineru" and model not in {"vlm", "pipeline"}:
        raise SettingsError("请选择受支持的 MinerU 解析模型。")
    if require_key and not key and (service == "mineru" or not local) and (service != "translation" or extra["provider"] == "ai" and not extra["useChatModel"]):
        raise SettingsError("请在设置中填写服务凭据。")
    result = {"baseUrl": base, "model": model, "key": key, "host": address.netloc, **extra}
    if service == "ai":
        if type(config.get("supportsImages", False)) is not bool:
            raise SettingsError("图像能力开关无效。")
        result["supportsImages"] = config.get("supportsImages", False)
    return result


def ai_configuration(service="ai"):
    config = effective(service)
    if service == "translation":
        if config["useChatModel"]:
            inherited = ai_configuration("ai")
            inherited["customPrompt"] = validated("translation", config)["customPrompt"]
            return inherited
        config = {**config, "provider": "ai"}
    if not config["baseUrl"] or not config["model"]:
        raise SettingsError("请先在设置中配置 AI 答疑或翻译专用模型。")
    result = validated(service, config, require_key=True)
    endpoint = result["baseUrl"]
    if not endpoint.endswith("/chat/completions"):
        endpoint += "/chat/completions"
    return {
        "url": endpoint,
        "model": result["model"],
        "key": result["key"],
        "host": result["host"],
        "supportsImages": result.get("supportsImages", False),
        "customPrompt": result.get("customPrompt", ""),
    }


def personalized_prompt(default, config):
    custom = config.get("customPrompt", "")
    return ("用户偏好：\n" + custom + "\n\n" if custom else "") + default


def available_models(service, payload):
    from urllib.error import HTTPError, URLError
    from urllib.request import Request, build_opener
    from ai_tutor import NoRedirect
    if not isinstance(service, str) or service not in {"ai", "translation"} or not isinstance(payload, dict):
        raise SettingsError("模型服务无效。")
    inherit = payload.get("useChatModel", effective("translation", read_key=False)["useChatModel"]) if service == "translation" else False
    if service == "translation" and inherit is True:
        config = effective("ai")
        config = validated("ai", {**config, "model": config.get("model") or "discovery"})
    else:
        config = candidate(service, {**payload, "model": payload.get("model") or "discovery"})
    base = config["baseUrl"].removesuffix("/chat/completions")
    headers = {"Accept": "application/json"}
    if config["key"]:
        headers["Authorization"] = "Bearer " + config["key"]
    try:
        with build_opener(NoRedirect()).open(Request(base + "/models", headers=headers), timeout=15) as response:
            body = response.read(1024 * 1024 + 1)
        if len(body) > 1024 * 1024:
            raise ValueError()
        rows = json.loads(body).get("data")
        if not isinstance(rows, list) or len(rows) > 1000:
            raise ValueError()
        if any(not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"].strip() for row in rows):
            raise ValueError()
        models = sorted({text(row["id"], "模型名称", 200) for row in rows if isinstance(row, dict) and isinstance(row.get("id"), str) and row["id"].strip()})
        return {"models": models}
    except HTTPError as error:
        raise SettingsError("无法读取模型，请检查服务地址与凭据。") from error
    except (URLError, TimeoutError, OSError) as error:
        raise SettingsError("无法连接模型服务，请确认服务已启动。") from error
    except (ValueError, AttributeError) as error:
        raise SettingsError("模型列表格式无效。") from error


def public_settings():
    services = {}
    for service in DEFAULTS:
        config = effective(service, read_key=False)
        try:
            check_service, check_config = service, config
            if service == "translation" and config["provider"] == "ai" and config["useChatModel"]:
                check_service, check_config = "ai", effective("ai", read_key=False)
            if service != "translation" or config["provider"] != "google":
                validated(check_service, {**check_config, "key": "present" if check_config["hasKey"] else ""}, require_key=True)
            ready, message = True, "配置完整"
        except SettingsError as error:
            ready, message = False, str(error)
        services[service] = {
            name: config[name] for name in ("baseUrl", "model", "source", "hasKey")
        }
        services[service].update(ready=ready, message=message)
        if service in {"ai", "translation"}:
            services[service]["customPrompt"] = config.get("customPrompt", "")
        if service == "ai":
            services[service]["supportsImages"] = config.get("supportsImages", False)
        if service == "translation":
            services[service].update(provider=config["provider"], useChatModel=config["useChatModel"])
    return {
        "services": services,
        "credentialStorage": "file",
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
    old = effective(service, read_key=False)
    draft = {**payload, "key": incoming}
    if service in {"ai", "translation"}:
        draft.setdefault("customPrompt", old.get("customPrompt", ""))
    if service == "translation":
        draft.setdefault("provider", old["provider"])
        draft.setdefault("useChatModel", old["useChatModel"])
    if service == "ai":
        draft.setdefault("supportsImages", old.get("supportsImages", False))
    config = validated(service, draft)
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
        data["services"][service] = {
            "baseUrl": config["baseUrl"],
            "model": config["model"],
            "key": config["key"],
        }
        if service == "ai":
            data["services"][service]["supportsImages"] = config["supportsImages"]
        if service in {"ai", "translation"}:
            data["services"][service]["customPrompt"] = config["customPrompt"]
        if service == "translation":
            data["services"][service].update(provider=config["provider"], useChatModel=config["useChatModel"])
        try:
            save(CONFIG, data)
        except OSError:
            raise SettingsError(
                "服务设置未保存，请检查本机存储后重试。"
            ) from None
        return public_settings()
