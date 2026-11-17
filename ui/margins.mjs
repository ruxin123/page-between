import { escapeHTML as esc, icon } from "./shared.mjs";
import { saveMargin } from "./saved-excerpts.mjs";
import { downloadFile } from "./export.mjs";
import { enablePanelDragging } from "./tutor.mjs";

function imagesFor(source) {
  const paths = new Set([source.image, ...(source.transferImages || []).map(image => image.url)]);
  return [...paths].filter(path => typeof path === "string" && (/^\/(?:demo-)?data\/books\/[A-Za-z0-9_-]+\/attachments\/[0-9a-f]{64}\.(png|jpg)$/.test(path) || /^data:image\/(?:png|jpeg);base64,[a-z0-9+/=]+$/i.test(path))).map(path => `<img src="${esc(path)}" alt="原文图像" loading="lazy">`).join("");
}

const types = { excerpts: "选段", bookmarks: "书签", translations: "译文", conversations: "答疑" };

export function createMargins({ api, post, toast, openSource, layout, canDock, isCurrent }) {
  const dialog = document.createElement("dialog");
  dialog.id = "reading-margins";
  dialog.className = "margins-dialog";
  dialog.setAttribute("aria-labelledby", "margins-title");
  dialog.innerHTML = `<header class="dialog-heading"><h2 id="margins-title">页边</h2><button class="icon-button" data-close aria-label="关闭页边">${icon("close")}</button></header>
    <div class="margins-tools"><select data-type aria-label="记录类型"><option value="">全部</option>${Object.entries(types).map(([key, label]) => `<option value="${key}">${label}</option>`).join("")}</select><select data-chapter aria-label="章节"></select><details><summary>导出</summary><div><button data-export="markdown">Markdown</button><button data-export="json">JSON</button><button data-export="pdf">注释 PDF</button></div></details></div>
    <div class="margin-undo" data-undo hidden><span>已删除选段</span><button class="secondary-button" data-restore>撤销</button></div>
    <div data-list></div><section data-detail hidden></section><p role="status" data-status></p>`;
  document.getElementById("reader").append(dialog);
  const $ = selector => dialog.querySelector(selector);
  let book, items = [], generation = 0, trigger, docked = false;
  const status = message => { $("[data-status]").textContent = message; };
  function close(reflow = true, returnFocus = true) {
    if (!dialog.open) return;
    generation++;
    const hide = () => {
      dialog.close();
      dialog.classList.remove("is-docked");
      document.getElementById("reader").classList.remove("margins-docked");
      document.getElementById("reading-records").setAttribute("aria-expanded", "false");
      docked = false;
    };
    if (docked && reflow) layout(hide); else hide();
    if (returnFocus) trigger?.focus({ preventScroll: true });
  }
  $("[data-close]").onclick = () => close();
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });

  function draw() {
    const chapter = $("[data-chapter]").value, type = $("[data-type]").value;
    const groups = new Map();
    items.forEach((item, index) => {
      if ((chapter && item.chapterKey !== chapter) || (type && item.recordType !== type)) return;
      const rows = groups.get(item.chapterKey) || [];
      rows.push(`<button class="margin-row" data-row="${index}"><small>${types[item.recordType]}</small><strong>${esc(item.recordType === "conversations" ? item.title : item.source.quote || item.text || item.title || item.label || "选段")}</strong>${item.note ? `<p>${esc(item.note)}</p>` : ""}</button>`);
      groups.set(item.chapterKey, rows);
    });
    const chapters = new Map(items.map(item => [item.chapterKey, item.chapter]));
    $("[data-list]").innerHTML = groups.size ? [...groups].map(([key, rows]) => `<section class="margin-chapter"><h3>${esc(chapters.get(key))}</h3>${rows.join("")}</section>`).join("") : '<p class="margin-empty">暂无记录</p>';
  }
  function back(focus = false) {
    generation++;
    $("[data-detail]").hidden = true;
    $("[data-list]").hidden = false;
    $(".margins-tools").hidden = false;
    status("");
    if (focus) $("[data-list] button")?.focus();
  }
  async function load() {
    back();
    const version = ++generation, chapter = $("[data-chapter]").value;
    status("正在读取…");
    try {
      const result = await api("/api/margins?all=1&book=" + encodeURIComponent(book.id));
      if (version !== generation || !dialog.open) return;
      items = result.items;
      const chapters = new Map(items.map(item => [item.chapterKey, item.chapter]));
      $("[data-chapter]").innerHTML = '<option value="">所有章节</option>' + [...chapters].map(([key, title]) => `<option value="${esc(key)}">${esc(title)}</option>`).join("");
      $("[data-chapter]").disabled = !chapters.size;
      if (chapters.has(chapter)) $("[data-chapter]").value = chapter;
      status("");
      draw();
    } catch (error) {
      if (version === generation) status(error.message);
    }
  }

  async function show(item, edit = false) {
    const version = ++generation, type = item.recordType, bookID = book.id;
    const path = {excerpts: "/api/margins/item", translations: "/api/translation/item", conversations: "/api/ai/conversations"}[type];
    status(path ? "正在读取…" : "");
    try {
      const response = path ? await api(`${path}?book=${encodeURIComponent(bookID)}&id=${encodeURIComponent(item.id)}&source=1`) : null;
      if (version !== generation || !dialog.open) return;
      const full = response?.item || response?.conversation || response || item;
      const source = full.source || item.source;
      const section = (title, html) => `<section class="margin-result"><h3>${title}</h3>${html}</section>`;
      let html = (type === "excerpts" ? response.html : response?.sourceHtml) || `<p>${esc(source.quote || full.label || "")}</p>`;
      html += imagesFor(source);
      const input = full.translationInput || (type === "translations" ? full.text : null);
      if (input && input !== source.quote) html += section("翻译输入", `<p>${esc(input)}</p>`);
      if (full.translation) html += section("译文", (type === "excerpts" ? response.translationHtml : full.html) || `<p>${esc(full.translation)}</p>`);
      if (full.answer) html += section("问答", response.answerHtml);
      if (full.explanationHtml && full.explanation) html += section("释义", full.explanationHtml);
      if (type === "conversations") html += full.messages.map(message => section(
        message.role === "user" ? "提问" : message.status === "generating" ? "回答生成中" : "回答",
        (message.html || `<p>${esc(message.content)}</p>`) + (message.references || []).map(ref => `<button class="margin-source-ref" data-ref="${esc(JSON.stringify(ref.position))}">${esc(ref.citation)}</button>`).join("")
      )).join("");
      $("[data-detail]").hidden = false;
      $("[data-list]").hidden = true;
      $(".margins-tools").hidden = true;
      const saved = type === "excerpts";
      $("[data-detail]").innerHTML = `<div class="margin-detail-actions"><button class="icon-button" data-record-back aria-label="返回列表">${icon("back")}</button><button class="primary-button" data-source>返回原文</button><details class="margin-more"><summary aria-label="更多记录操作">⋯</summary><div>${source.quote ? '<button data-copy-source>复制原文</button><button data-pin>固定引用</button>' : ""}<button data-link>复制原文链接</button>${saved ? '<button class="margin-remove" data-remove>删除选段</button>' : ""}</div></details></div>
        <p class="margin-citation">${esc(source.citation)}</p><div class="ai-markdown margin-quote">${html}</div>
        ${saved ? `<p class="margin-saved-note" data-note-preview ${full.note ? "" : "hidden"}>${esc(full.note || "")}</p><button class="secondary-button" data-edit-note>${full.note ? "编辑笔记" : "记一句"}</button><div data-editor hidden><label class="margin-note">笔记<textarea maxlength="2000" rows="3">${esc(full.note || "")}</textarea></label><button class="secondary-button" data-save-note>保存笔记</button></div>` : type === "bookmarks" ? "" : `<button class="secondary-button" data-keep ${full.messages?.at(-1)?.status === "generating" ? "disabled" : ""}>保存到页边</button>`}`;
      status("");
      $("[data-record-back]").onclick = () => back(true);
      $("[data-source]").onclick = () => { close(false, false); openSource(bookID, source.position); };
      for (const button of dialog.querySelectorAll("[data-ref]")) button.onclick = () => { close(false, false); openSource(bookID, JSON.parse(button.dataset.ref)); };
      const copy = async text => {
        try { await navigator.clipboard.writeText(text); toast("已复制。"); }
        catch { status("暂时无法复制，请重试。"); }
      };
      $("[data-link]").onclick = () => copy(item.sourceLink);
      if ($("[data-copy-source]")) $("[data-copy-source]").onclick = () => copy(source.quote);
      if ($("[data-pin]")) $("[data-pin]").onclick = () => { close(); pin({ book: bookID, source }); };
      if (saved) {
        const enterNote = () => { $("[data-editor]").hidden = false; $("[data-edit-note]").hidden = true; $("textarea").focus(); };
        $("[data-edit-note]").onclick = enterNote;
        $("[data-save-note]").onclick = async event => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const note = $("textarea").value;
            await post("/api/margins", { book: bookID, id: full.id, operation: "note", note });
            if (version !== generation) return;
            item.note = note;
            draw();
            $("[data-note-preview]").textContent = note;
            $("[data-note-preview]").hidden = !note;
            $("[data-editor]").hidden = true;
            $("[data-edit-note]").hidden = false;
            $("[data-edit-note]").textContent = note ? "编辑笔记" : "记一句";
            $("[data-edit-note]").focus();
          } catch (error) { if (version === generation) status(error.message); }
          finally { button.disabled = false; }
        };
        $("[data-remove]").onclick = async event => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            await post("/api/margins", { book: bookID, id: full.id, operation: "remove" });
            if (version !== generation) return;
            await load();
            if (!dialog.open || book.id !== bookID) return;
            $("[data-undo]").hidden = false;
            $("[data-restore]").onclick = async () => {
              try {
                await post("/api/margins", { book: bookID, id: full.id, operation: "restore" });
                if (dialog.open && book.id === bookID) { $("[data-undo]").hidden = true; await load(); }
              } catch (error) { status(error.message); }
            };
          } catch (error) { if (version === generation) status(error.message); }
          finally { button.disabled = false; }
        };
        if (edit) enterNote(); else $("[data-record-back]").focus();
      } else {
        $("[data-record-back]").focus();
        if ($("[data-keep]")) $("[data-keep]").onclick = async event => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const saved = await saveMargin(post, {book: bookID, source}, {type: type === "translations" ? "translation" : "ai", id: full.id});
            if (version !== generation) return;
            await load();
            const row = items.find(item => item.recordType === "excerpts" && item.id === saved.item.id);
            if (row) await show(row);
          } catch (error) { status(error.message); }
          finally { button.disabled = false; }
        };
      }
    } catch (error) { if (version === generation) status(error.message); }
  }
  $("[data-list]").onclick = event => {
    const row = event.target.closest("[data-row]");
    if (row) show(items[Number(row.dataset.row)]);
  };
  $("[data-type]").onchange = $("[data-chapter]").onchange = draw;
  for (const button of dialog.querySelectorAll("[data-export]")) button.onclick = async () => {
    button.disabled = true;
    try { downloadFile(await post("/api/margins/export", { book: book.id, format: button.dataset.export })); }
    catch (error) { status(error.message); }
    finally { button.disabled = false; }
  };
  async function open(value, type = "") {
    book = value;
    $('[data-export="pdf"]').hidden = book.type !== "pdf";
    $("[data-undo]").hidden = true;
    $("[data-type]").value = type;
    if (!dialog.open) {
      trigger = document.activeElement;
      docked = canDock();
      const present = () => {
        dialog.classList.toggle("is-docked", docked);
        document.getElementById("reader").classList.toggle("margins-docked", docked);
        document.getElementById("reading-records").setAttribute("aria-expanded", "true");
        if (docked) dialog.show(); else dialog.showModal();
        $("[data-close]").focus({preventScroll:true});
      };
      if (docked) layout(present); else present();
    }
    await load();
  }
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
      content.innerHTML = result.html + imagesFor(context.source);
    } catch {
      if (version === pinnedRevision) content.insertAdjacentHTML("beforeend", imagesFor(context.source));
    }
  }
  return {
    open, close, get active() { return dialog.open; },
    adapt() {
      if (!dialog.open || docked === canDock()) return;
      const focus = document.activeElement;
      docked = canDock();
      dialog.close();
      dialog.classList.toggle("is-docked", docked);
      document.getElementById("reader").classList.toggle("margins-docked", docked);
      if (docked) dialog.show(); else dialog.showModal();
      (focus !== dialog && dialog.contains(focus) ? focus : $("[data-close]")).focus({preventScroll:true});
    },
    async save(context, value) {
      try {
        const result = await saveMargin(post, context);
        if (value && isCurrent(value.id)) {
          await open(value);
          const row = items.find(item => item.recordType === "excerpts" && item.id === result.item.id);
          if (row) await show(row, true);
        } else toast("已保存到页边。", { kind: "success" });
      } catch (error) { toast(error.message, { kind: "error" }); }
    },
    pin,
  };
}
