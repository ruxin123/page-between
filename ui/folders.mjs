import { escapeHTML as esc, icon } from "./shared.mjs";

export function inFolder(books, folders, selected) {
  if (!selected) return books;
  const assigned = new Set(folders.flatMap(folder => folder.books));
  const members = new Set(folders.find(folder => folder.id === selected)?.books || []);
  return books.filter(book => selected === "unfiled" ? !assigned.has(book.id) : members.has(book.id));
}

export function createFolders({ post, refresh, changed }) {
  const host = document.getElementById("folder-navigation");
  const dialog = document.createElement("dialog");
  dialog.className = "folder-dialog";
  dialog.innerHTML = `<form><h2></h2><label>名称<input name="name" maxlength="60" required autocomplete="off"></label><p role="alert"></p><div class="dialog-actions"><button type="button" data-cancel class="secondary-button">取消</button><button class="primary-button">保存</button></div></form>`;
  document.body.append(dialog);
  let folders = [], selected = "", editing = null;
  const form = dialog.querySelector("form");
  dialog.querySelector("[data-cancel]").onclick = () => dialog.close();
  function edit(folder) {
    editing = folder;
    dialog.querySelector("h2").textContent = folder ? "重命名文件夹" : "新建文件夹";
    form.elements.name.value = folder?.name || "";
    dialog.querySelector("[role=alert]").textContent = "";
    dialog.showModal(); form.elements.name.focus();
  }
  form.onsubmit = async event => {
    event.preventDefault();
    const save = form.querySelector(".primary-button"); save.disabled = true;
    try {
      const result = await post("/api/folders", { operation: editing ? "rename" : "create", id: editing?.id, name: form.elements.name.value });
      if (!editing) selected = result.folders.at(-1).id;
      await refresh(); changed(); dialog.close();
    } catch (error) { dialog.querySelector("[role=alert]").textContent = error.message; }
    finally { save.disabled = false; }
  };
  host.onclick = async event => {
    const button = event.target.closest("button"); if (!button) return;
    if (button.dataset.folder !== undefined) { selected = button.dataset.folder; changed(); host.querySelector(`[data-folder="${CSS.escape(selected)}"]`)?.focus(); }
    else if (button.dataset.folderAction === "new") edit(null);
    else if (button.dataset.folderAction === "rename") edit(folders.find(folder => folder.id === selected));
    else if (button.dataset.folderAction === "remove") {
      if (!window.confirm("删除这个文件夹？书籍将保留在书库中。")) return;
      button.disabled = true;
      try { await post("/api/folders", {operation: "remove", id: selected}); selected = ""; await refresh(); changed(); }
      catch (error) { window.alert(error.message); }
      finally { button.disabled = false; }
    }
  };
  return {
    get selected() { return selected; },
    reset() { selected = ""; },
    render(value, books) {
      folders = value;
      if (selected && selected !== "unfiled" && !folders.some(folder => folder.id === selected)) selected = "";
      const active = new Set(books.map(book => book.id));
      host.innerHTML = `<div class="folder-list"><button data-folder="" aria-pressed="${!selected}">全部书籍</button><button data-folder="unfiled" aria-pressed="${selected === "unfiled"}">未分类</button>${folders.map(folder => `<button data-folder="${esc(folder.id)}" aria-pressed="${selected === folder.id}">${icon("shelf")}${esc(folder.name)}<span>${folder.books.filter(id => active.has(id)).length}</span></button>`).join("")}</div><div class="folder-actions">${selected && selected !== "unfiled" ? `<button class="icon-button" data-folder-action="rename" aria-label="重命名文件夹">${icon("edit")}</button><button class="icon-button" data-folder-action="remove" aria-label="删除文件夹">${icon("close")}</button>` : ""}<button class="secondary-button" data-folder-action="new">${icon("plus")}新建文件夹</button></div>`;
    },
    options(book) { const member = folders.find(folder => folder.books.includes(book.id))?.id || ""; return `<label>文件夹<select id="book-folder"><option value="">未分类</option>${folders.map(folder => `<option value="${esc(folder.id)}" ${member === folder.id ? "selected" : ""}>${esc(folder.name)}</option>`).join("")}</select></label>`; },
    async assign(book, id) { const current = folders.find(folder => folder.books.includes(book.id))?.id || ""; if (current !== id) await post("/api/folders", {operation: "assign", book: book.id, id}); },
  };
}
