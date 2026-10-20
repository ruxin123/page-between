"""Bounded raster attachments owned by a book; never fetch image URLs."""

import base64
import binascii
import hashlib
import io
import os
import re
import tempfile
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

import book_import
from paths import DATA_PREFIX

MAX_BYTES = 4 * 1024**2
MAX_SIDE = 4096


def inspect_image(body):
    if not body or len(body) > MAX_BYTES:
        raise ValueError("原图为空或超过 4 MB，请缩小选取范围后重试。")
    try:
        image = Image.open(io.BytesIO(body))
        if image.format not in {"PNG", "JPEG"} or max(image.size) > MAX_SIDE:
            image.close()
            raise ValueError("请选择不超过 4096 像素的 PNG 或 JPEG 原图。")
        return image
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise ValueError("原图无法读取，请重新选择完整图表。") from None


def stored_image(book, url, *, root=None):
    prefix = f"{DATA_PREFIX}/books/{book['id']}/attachments/"
    if (
        not isinstance(url, str)
        or not url.startswith(prefix)
        or not re.fullmatch(r"[0-9a-f]{64}\.(png|jpg)", url[len(prefix) :])
    ):
        raise ValueError("图片必须来自这本书的已保存选段。")
    directory = (Path(root) if root is not None else book_import.BOOK_ROOT) / book["id"]
    path = directory / "attachments" / url[len(prefix) :]
    if (
        path.is_symlink()
        or not path.resolve().is_relative_to(directory.resolve())
        or not path.is_file()
        or path.stat().st_size > MAX_BYTES
    ):
        raise ValueError("选段原图不可用，请回到原书重新选择。")
    body = path.read_bytes()
    if hashlib.sha256(body).hexdigest() != path.stem:
        raise ValueError("选段原图校验失败，请回到原书重新选择。")
    try:
        with inspect_image(body) as image:
            mime = "image/png" if image.format == "PNG" else "image/jpeg"
            if (path.suffix == ".png") != (mime == "image/png"):
                raise ValueError("选段原图类型不一致。")
            image.verify()
    except (OSError, SyntaxError):
        raise ValueError("选段原图校验失败，请回到原书重新选择。") from None
    return body, mime


def save_image(book, value, *, root=None):
    if not isinstance(value, str):
        raise ValueError("原图格式无效。")
    if not value.startswith("data:"):
        stored_image(book, value, root=root)
        return value
    if root is not None:
        raise ValueError("备份中的选段必须引用已保存的原图。")
    header, _, encoded = value.partition(",")
    if (
        header not in {"data:image/png;base64", "data:image/jpeg;base64"}
        or len(encoded) > (MAX_BYTES + 2) // 3 * 4
    ):
        raise ValueError("请选择不超过 4 MB 的 PNG 或 JPEG 原图。")
    try:
        body = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("原图编码无效，请重新选择图表。") from None
    try:
        with inspect_image(body) as source:
            source.load()
            jpeg = source.format == "JPEG"
            image = ImageOps.exif_transpose(source).convert("RGB" if jpeg else "RGBA")
            image.info.clear()
            output = io.BytesIO()
            image.save(
                output,
                format="JPEG" if jpeg else "PNG",
                **({"quality": 95} if jpeg else {}),
            )
            image.close()
            body = output.getvalue()
    except (OSError, SyntaxError):
        raise ValueError("原图未能完整解码，请重新选择图表。") from None
    if len(body) > MAX_BYTES:
        raise ValueError("原图整理后超过 4 MB，请缩小选取范围。")
    name = hashlib.sha256(body).hexdigest() + (".jpg" if jpeg else ".png")
    directory = book_import.BOOK_ROOT / book["id"] / "attachments"
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=directory, prefix=".image-", delete=False
    ) as temporary:
        path = Path(temporary.name)
        temporary.write(body)
        temporary.flush()
        os.fsync(temporary.fileno())
    try:
        path.replace(directory / name)
    finally:
        path.unlink(missing_ok=True)
    return f"{DATA_PREFIX}/books/{book['id']}/attachments/{name}"


def image_part(book, url):
    body, mime = stored_image(book, url)
    return {
        "type": "image_url",
        "image_url": {
            "url": f"data:{mime};base64," + base64.b64encode(body).decode("ascii")
        },
    }
