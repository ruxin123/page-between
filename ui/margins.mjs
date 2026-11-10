import { escapeHTML as esc, icon } from "./shared.mjs";
import { saveMargin } from "./saved-excerpts.mjs";
import { downloadFile } from "./export.mjs";
import { enablePanelDragging } from "./tutor.mjs";

export function createMargins({ api, post, toast, getBookmarks, openSource }) {
  const dialog = document.createElement("dialog");
  dialog.className = "margins-dialog";
  dialog.innerHTML = `<header class="dialog-heading"><h2>页边</h2><button class="icon-button" data-close aria-label="关闭页边">${icon("close")}</button></header><div class="margins-tools"><select data-type aria-label="记录类型"><option value="excerpts">选段</option><option value="bookmarks">书签</option><option value="translations">翻译收藏</option><option value="conversations">答疑</option></select><select data-chapter aria-label="章节"><option value="">所有章节</option></select><details><summary>导出</summary><button data-export="markdown">Markdown</button><button data-export="json">JSON</button></details></div><div class="margin-undo" data-undo hidden><span>已删除选段</span><button class="secondary-button" data-restore>撤销</button></div><div data-list></div><section data-detail hidden></section><p role="status" data-status></p>`;
  document.body.append(dialog);
  const pdfExport = document.createElement("button");
  pdfExport.dataset.export = "pdf";
  pdfExport.textContent = "注释 PDF";
  dialog.querySelector("details").append(pdfExport);
  const $ = selector => dialog.querySelector(selector);
  let book, items = [], generation = 0;
  $("[data-close]").onclick = () => dialog.close();
  dialog.addEventListener("close", () => { generation++; });
  function source(item) { return item.source || { position: item.position, citation: item.detail || item.label }; }
  function draw() {
    const chapter = $("[data-chapter]").value;
    const filtered = items.filter(item => !chapter || String(item.chapter || source(item).position?.index) === chapter);
    $("[data-list]").innerHTML = filtered.length ? filtered.map(item => `<button class="margin-row" data-id="${esc(item.id)}"><strong>${esc(item.source?.quote || item.text || item.title || item.label || "选段")}</strong><small>${esc(source(item).citation)}</small>${item.note ? `<p>${esc(item.note)}</p>` : ""}</button>`).join("") : '<p class="margin-empty">暂无记录</p>';
  }
  async function load() {
    const version = ++generation;
    const previousChapter = $("[data-chapter]").value;
    items = [];
    $("[data-list]").textContent = "";
    $("[data-status]").textContent = "正在读取…";
    $("[data-detail]").hidden = true;
    $("[data-list]").hidden = false;
    $(".margins-tools").hidden = false;
    try {
      const type = $("[data-type]").value;
      const path = { excerpts: "/api/margins", translations: "/api/translation/history", conversations: "/api/ai/conversations" }[type];
      const result = path ? await api(path + "?book=" + encodeURIComponent(book.id)) : null;
      if (version !== generation || !dialog.open) return;
      items = type === "bookmarks" ? getBookmarks().filter(mark => mark.book === book.id) : result.items || result.conversations;
      const chapters = new Map(items.filter(item => source(item).position?.index).map(item => [item.chapter || source(item).position.index, item.chapter || source(item).citation]));
      $("[data-chapter]").innerHTML = '<option value="">所有章节</option>' + [...chapters].map(([index, title]) => `<option value="${index}">${esc(title)}</option>`).join("");
      $("[data-chapter]").disabled = !chapters.size;
      if ([...chapters.keys()].some(key => String(key) === previousChapter)) $("[data-chapter]").value = previousChapter;
      $("[data-status]").textContent = "";
      draw();
    } catch (error) {
      if (version === generation) $("[data-status]").textContent = error.message;
    }
  }
  async function show(item) {
    const version = ++generation, type = $("[data-type]").value;
    $("[data-status]").textContent = "";
    try {
      let full = item, html = "";
      if (type === "excerpts") {
        const response = await api(`/api/margins/item?book=${encodeURIComponent(book.id)}&id=${item.id}`);
        full = response.item; html = response.html + (full.translation ? `<section><h3>译文</h3>${response.translationHtml}</section>` : "") + (full.answer ? `<section><h3>答疑</h3>${response.answerHtml}</section>` : "");
      } else if (type === "translations") {
        full = await api(`/api/translation/item?book=${encodeURIComponent(book.id)}&id=${item.id}`);
        html = full.html;
      } else if (type === "conversations") {
        const response = await api(`/api/ai/conversations?book=${encodeURIComponent(book.id)}&id=${item.id}`);
        full = response.conversation;
        html = full.messages.map(message => `<section><h3>${message.role === "user" ? "提问" : "答疑"}</h3>${message.html || `<p>${esc(message.content)}</p>`}</section>`).join("");
      }
      if (version !== generation || !dialog.open) return;
      $("[data-detail]").hidden = false;
      $("[data-list]").hidden = true;
      $(".margins-tools").hidden = true;
      $("[data-detail]").innerHTML = `<div class="margin-detail-actions"><button class="secondary-button" data-record-back>返回列表</button><button class="secondary-button" data-source>返回原文</button><button class="secondary-button" data-copy-source ${source(full).kind === "image" ? "hidden" : ""}>复制原文</button><button class="secondary-button" data-pin ${source(full).quote ? "" : "disabled"}>固定引用</button>${type === "excerpts" ? '<button class="secondary-button" data-remove>删除</button>' : ''}</div><p class="margin-citation">${esc(source(full).citation)}</p><div class="ai-markdown">${html || `<p>${esc(full.label)}</p>`}${source(full).image ? `<img src="${esc(source(full).image)}" alt="原文图像">` : ""}</div>${type === "excerpts" ? `<label class="margin-note">笔记<textarea maxlength="2000" rows="3">${esc(full.note || "")}</textarea></label><button class="secondary-button" data-save-note>保存笔记</button>` : type === "bookmarks" ? "" : `<button class="secondary-button" data-keep>保存到页边</button>`}`;
      $("[data-record-back]").onclick = load;
      $("[data-copy-source]").onclick = async () => {
        try { await navigator.clipboard.writeText(source(full).quote); $("[data-status]").textContent = "已复制原文。"; }
        catch { $("[data-status]").textContent = "暂时无法复制，请返回原文重试。"; }
      };
      $("[data-source]").onclick = () => { dialog.close(); openSource(book.id, source(full).position); };
      $("[data-pin]").onclick = () => { dialog.close(); pin({ book: book.id, source: source(full) }); };
      if (type === "excerpts") {
        $("[data-save-note]").onclick = async event => {
          const button = event.currentTarget; button.disabled = true;
          try { await post("/api/margins", { book: book.id, id: full.id, operation: "note", note: $("textarea").value }); $("[data-status]").textContent = "笔记已保存。"; }
          catch (error) { $("[data-status]").textContent = error.message; }
          finally { button.disabled = false; }
        };
        $("[data-remove]").onclick = async event => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            await post("/api/margins", { book: book.id, id: full.id, operation: "remove" });
            const removedBook = book.id;
            await load();
            $("[data-undo]").hidden = false;
            $("[data-restore]").onclick = async () => {
              try {
              await post("/api/margins", { book: removedBook, id: full.id, operation: "restore" });
              if (dialog.open && book.id === removedBook) { $("[data-undo]").hidden = true; await load(); }
              } catch (error) { $("[data-status]").textContent = error.message; }
            };
          } catch (error) { $("[data-status]").textContent = error.message; }
          finally { button.disabled = false; }
        };
      } else if ($("[data-keep]")) $("[data-keep]").onclick = async () => {
        try {
          await saveMargin(post, { book: book.id, source: source(full) }, type === "bookmarks" ? undefined : { type: type === "translations" ? "translation" : "ai", id: full.id });
          toast("已保存到页边。");
        } catch (error) { $("[data-status]").textContent = error.message; }
      };
    } catch (error) { if (version === generation) $("[data-status]").textContent = error.message; }
  }
  $("[data-list]").onclick = event => {
    const row = event.target.closest("[data-id]");
    if (row) show(items.find(item => item.id === row.dataset.id));
  };
  $("[data-type]").onchange = load;
  $("[data-chapter]").onchange = draw;
  for (const button of dialog.querySelectorAll("[data-export]")) button.onclick = async () => {
    button.disabled = true;
    try { downloadFile(await post("/api/margins/export", { book: book.id, format: button.dataset.export })); }
    catch (error) { $("[data-status]").textContent = error.message; }
    finally { button.disabled = false; }
  };
  const reference = document.createElement("aside");
  reference.className = "pinned-reference";
  reference.hidden = true;
  reference.innerHTML = `<header><strong>固定引用</strong><button class="icon-button" data-close-reference aria-label="关闭引用">${icon("close")}</button></header><div class="ai-markdown" data-reference></div><button class="secondary-button" data-reference-source>返回原文</button>`;
  document.body.append(reference);
  enablePanelDragging(reference, reference.querySelector("header"));
  let pinned, pinnedRevision = 0;
  reference.querySelector("[data-close-reference]").onclick = () => { reference.hidden = true; pinned = null; pinnedRevision++; };
  reference.querySelector("[data-reference-source]").onclick = () => { if (pinned) openSource(pinned.book, pinned.source.position); };
  async function pin(context) {
    const version = ++pinnedRevision;
    pinned = structuredClone(context);
    reference.hidden = false;
    const content = reference.querySelector("[data-reference]");
    content.textContent = context.source.quote || "";
    try {
      const result = await post("/api/translation/preview", { ...context, text: context.source.quote });
      if (version !== pinnedRevision) return;
      content.innerHTML = result.html + (context.source.image ? `<img src="${esc(context.source.image)}" alt="原文图像">` : "");
    } catch { if (version === pinnedRevision && context.source.image) content.innerHTML = `<img src="${esc(context.source.image)}" alt="原文图像">`; }
  }
  return {
    async open(value, type = "excerpts") {
      book = value;
      pdfExport.hidden = book.type !== "pdf";
      $("[data-undo]").hidden = true;
      $("[data-type]").value = type;
      if (!dialog.open) dialog.showModal();
      await load();
    },
    async save(context) {
      try { await saveMargin(post, context); toast("已保存到页边。", { kind: "success" }); }
      catch (error) { toast(error.message, { kind: "error" }); }
    },
    pin,
  };
}
