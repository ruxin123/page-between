import { escapeHTML as esc, icon } from "./shared.mjs";

function metadataText(value) {
  if (Array.isArray(value)) return value.map(metadataText).filter(Boolean).join("、");
  if (value && typeof value === "object") return metadataText(value.name ?? value.title ?? value.value ?? value.rating ?? value.score);
  return value == null ? "" : String(value);
}
export function metadataHTML(detail) {
  const fields = [["出版社", detail.publisher], ["年份", detail.year], ["语言", detail.language], ["页数", detail.pages], ["文件", [detail.format?.toUpperCase(), detail.size_mb ? detail.size_mb + " MB" : ""].filter(Boolean).join(" · ")], ["ISBN", detail.isbn], ["系列", detail.series], ["版次", detail.edition], ["译者", detail.translator], ["分类", detail.categories], ["评分", detail.rating]];
  const facts = fields.map(([name, value]) => [name, metadataText(value)]).filter(([, value]) => value);
  return `<dl class="source-metadata">${facts.map(([name, value]) => `<div><dt>${name}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>${detail.description ? `<section class="source-description"><h2>简介</h2><p>${esc(detail.description)}</p></section>${detail.description_truncated ? '<span class="source-excerpt">简介节选</span>' : ""}` : ""}`;
}

export function createBookSource({ api, post, refresh }) {
  const page = document.getElementById("book-source-view");
  page.innerHTML = `<div data-catalog><header class="page-heading"><div><h1>找书</h1></div><a class="secondary-button" href="#/settings/source">书源设置</a></header>
    <form data-search class="source-search"><label>${icon("search")}<input name="query" type="search" maxlength="500" placeholder="书名、作者或 ISBN" aria-label="搜索书籍"></label><select name="format" aria-label="文件格式"><option value="">所有格式</option><option>epub</option><option>pdf</option><option>txt</option><option>mobi</option><option>azw3</option></select><button class="primary-button">搜索</button><details class="source-filters"><summary>筛选</summary><div><input name="author" placeholder="作者" aria-label="作者" maxlength="200"><select name="language" aria-label="语言"><option value="">所有语言</option><option value="chinese">中文</option><option value="english">英文</option><option value="japanese">日文</option><option value="french">法文</option><option value="german">德文</option></select><label><input name="exact" type="checkbox">精确匹配</label></div></details></form>
    <div class="source-results-heading" hidden><p data-status role="status" aria-live="polite"></p></div><div class="source-browser"><div data-results></div></div><button data-more hidden class="secondary-button">更多结果</button></div><article data-detail-page class="source-detail-page" hidden><a class="source-back" href="#/source">${icon("back")}返回搜索结果</a><div data-detail></div><p data-detail-status role="status" aria-live="polite"></p></article>`;
  const $ = (selector) => page.querySelector(selector);
  const supported = api("/api/formats").then(data => new Set(data.formats.map(item => item.extension.slice(1)))).catch(() => new Set());
  let cursor,
    revision = 0,
    rows = [],
    selected,
    downloading = false, listScroll = 0;
  const status = (message) => {
    $("[data-status]").textContent = message;
    $("[data-detail-status]").textContent = message;
    $(".source-results-heading").hidden = !message;
  };
  async function search(more = false) {
    if (downloading) return;
    const version = ++revision,
      form = $("[data-search]");
    form.querySelector("button").disabled = true;
    $("[data-more]").disabled = true;
    status("正在搜索…");
    try {
      const result = await post("/api/book-source/query", {
        operation: "search",
        ...(more
          ? { cursor }
          : {
              query: form.elements.query.value,
              format: form.elements.format.value,
              author: form.elements.author.value,
              language: form.elements.language.value,
              exact: form.elements.exact.checked,
            }),
      });
      if (version !== revision) return;
      rows = more ? [...rows, ...result.rows] : result.rows;
      if (!more) {
        selected = null;

      }
      cursor = result.next_cursor;
      $("[data-more]").hidden = !cursor;
      $("[data-results]").innerHTML = rows.length
        ? rows
            .map(
              (row, index) =>
                `<button class="source-result" data-index="${index}"><span class="source-cover" aria-hidden="true"><span>${esc(row.title || "BOOK")}</span><small>${esc(row.format || "BOOK")}</small></span><span><strong>${esc(row.title || "未命名")}</strong><small>${esc([row.author, row.publisher, row.year].filter(Boolean).join(" · "))}</small><small>${esc([row.language, row.pages ? row.pages + " 页" : "", row.format?.toUpperCase(), row.size_mb ? row.size_mb + " MB" : ""].filter(Boolean).join(" · "))}</small></span><span>›</span></button>`,
            )
            .join("")
        : "<p>未找到书籍</p>";
      status(rows.length ? `${rows.length} 个版本` : "");

    } catch (error) {
      status(error.message);
    } finally {
      if (version === revision) {
        form.querySelector("button").disabled = false;
        $("[data-more]").disabled = false;
      }
    }
  }
  $("[data-search]").onsubmit = (event) => {
    event.preventDefault();
    search();
  };
  $("[data-more]").onclick = () => search(true);
  $("[data-results]").onclick = (event) => {
    const button = event.target.closest("[data-index]");
    if (!button || downloading) return;
    const row = rows[Number(button.dataset.index)];
    listScroll = page.closest(".workspace-main").scrollTop;
    location.hash = "#/source/book/" + encodeURIComponent(row.ref);
  };
  async function showDetail(ref) {
    if (downloading) {
      if (selected?.ref !== ref) { location.hash = "#/source/book/" + encodeURIComponent(selected.ref); return; }
      $("[data-catalog]").hidden = true;
      $("[data-detail-page]").hidden = false;
      return;
    }
    const row = rows.find(row => row.ref === ref) || {ref};
    selected = row;
    const version = revision;
    $("[data-catalog]").hidden = true;
    $("[data-detail-page]").hidden = false;
    $("[data-detail]").innerHTML = '<p role="status">正在读取版本…</p>';
    $("[data-detail-status]").textContent = "";
    page.closest(".workspace-main").scrollTop = 0;
    try {
      const detail = await post("/api/book-source/query", {
        operation: "details",
        ref: row.ref,
      });
      if (selected !== row || version !== revision || page.hidden || $("[data-detail-page]").hidden) return;
      const format = (detail.format || row.format || "").toLowerCase();
      const book = {...row, ...detail};
      const tooLarge = Number(book.size_mb) > 200;
      const canImport = (await supported).has(format) && !tooLarge;
      $("[data-detail]").innerHTML = `<div class="source-detail-hero"><div class="source-cover source-cover-large" aria-hidden="true"><span>${esc(book.title || "未命名")}</span><small>${esc(format)}</small></div><div class="source-detail-title"><h1 tabindex="-1">${esc(book.title || "未命名")}</h1>${book.author ? `<p class="source-author">${esc(book.author)}</p>` : ""}<div class="source-acquire"><button data-download class="primary-button" ${canImport ? "" : "disabled"}>${canImport ? icon("import") + "下载导入" : tooLarge ? "超过 200 MB" : "暂不支持此格式"}</button><label ${canImport ? "" : "hidden"}><input type="checkbox" data-parse ${["pdf", "txt", "djvu"].includes(format) ? "checked" : ""}>文档解析</label></div></div></div><div class="source-detail-body">${metadataHTML(book)}</div>`;
      $("[data-download]").onclick = () => download(row);
      $("[data-detail] h1").focus({preventScroll:true});
    } catch (error) {
      if (selected === row && version === revision) $("[data-detail]").textContent = error.message;
    }
  }
  async function download(row) {
    if (downloading) return;
    downloading = true;
    $("[data-download]").disabled = true;
    try {
      let task = await post("/api/book-source/download", {
        ref: row.ref,
        parse: $("[data-parse]").checked,
      });
      while (["downloading", "importing"].includes(task.status)) {
        status(task.status === "downloading" ? "正在下载…" : "正在加入书库…");
        await new Promise((resolve) => setTimeout(resolve, 800));
        task = await api(
          "/api/book-source/task?id=" + encodeURIComponent(task.id),
        );
      }
      if (task.status === "error") throw Error(task.error);
      status(task.duplicate ? "书库中已有此书" : "已加入书库");
      await refresh();
      $("[data-download]").textContent = "开始阅读";
      $("[data-download]").onclick = () => {
        location.hash = "#/read/" + task.book.id;
      };
    } catch (error) {
      status(error.message);
    } finally {
      downloading = false;
      $("[data-download]").disabled = false;
    }
  }
  return {
    open(parts = []) {
      if (parts[0] === "book" && parts[1]) {
        try { showDetail(decodeURIComponent(parts[1])); }
        catch { location.hash = "#/source"; }
        return;
      }
      $("[data-catalog]").hidden = false;
      $("[data-detail-page]").hidden = true;
      const button = [...$("[data-results]").querySelectorAll("[data-index]")].find(button => rows[Number(button.dataset.index)]?.ref === selected?.ref);
      (button || $("[data-search] input")).focus({preventScroll:true});
      requestAnimationFrame(() => { page.closest(".workspace-main").scrollTop = listScroll; });
    },
  };
}
