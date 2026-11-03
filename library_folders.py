"""User collections live in the library catalogue; originals are never moved."""
import unicodedata
import uuid


def validate(folders, book_ids):
    if not isinstance(folders, list) or len(folders) > 1000:
        raise ValueError("文件夹数据无效。")
    ids, names, assigned = set(), set(), set()
    for folder in folders:
        if not isinstance(folder, dict) or not isinstance(folder.get("id"), str) or not folder["id"] or folder["id"] in ids:
            raise ValueError("文件夹标识无效。")
        name = folder_name(folder.get("name"))
        if name.casefold() in names:
            raise ValueError("已有同名文件夹。")
        members = folder.get("books")
        if not isinstance(members, list) or any(not isinstance(book, str) or book not in book_ids or book in assigned for book in members) or len(set(members)) != len(members):
            raise ValueError("文件夹中的书籍无效。")
        ids.add(folder["id"]); names.add(name.casefold()); assigned.update(members)


def folder_name(value):
    if not isinstance(value, str):
        raise ValueError("请填写文件夹名称。")
    value = unicodedata.normalize("NFC", value.strip())
    if not value or len(value) > 60 or any(unicodedata.category(c).startswith("C") for c in value):
        raise ValueError("文件夹名称需为 1–60 个字符。")
    return value


def change(collection, payload):
    folders = collection.setdefault("folders", [])
    operation = payload.get("operation")
    folder = next((item for item in folders if item["id"] == payload.get("id")), None)
    if operation in {"create", "rename"}:
        name = folder_name(payload.get("name"))
        if any((operation == "create" or item is not folder) and item["name"].casefold() == name.casefold() for item in folders):
            raise ValueError("已有同名文件夹。")
        if operation == "create":
            if len(folders) >= 1000: raise ValueError("文件夹数量已达上限。")
            folder = {"id": uuid.uuid4().hex, "name": name, "books": []}
            folders.append(folder)
        elif folder:
            folder["name"] = name
        else: raise ValueError("找不到这个文件夹。")
    elif operation == "remove":
        if not folder: raise ValueError("找不到这个文件夹。")
        folders.remove(folder)
    elif operation == "assign":
        book = payload.get("book")
        if not any(item["id"] == book and not item.get("deletedAt") for item in collection["books"]):
            raise ValueError("找不到这本书。")
        if payload.get("id") != "" and not folder: raise ValueError("找不到这个文件夹。")
        for item in folders: item["books"] = [ident for ident in item["books"] if ident != book]
        if folder: folder["books"].append(book)
    else: raise ValueError("文件夹操作无效。")
    return folders
