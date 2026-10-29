import { escapeHTML as esc, icon } from "./shared.mjs";

export function createBookSource({ api, post, refresh }) {
  const page = document.getElementById("book-source-view");
  page.innerHTML = `<header class="page-heading"><div><div class="eyebrow">DISCOVER</div><h1>找书</h1></div><a class="secondary-button" href="#/settings/source">书源设置</a></header>
    <form data-search class="source-search"><label>${icon("search")}<input name="query" type="search" required maxlength="500" placeholder="书名、作者或 ISBN" aria-label="搜索书籍"></label><select name="format" aria-label="文件格式"><option value="">所有格式</option><option>epub</option><option>pdf</option><option>txt</option><option>mobi</option><option>azw3</option><option>djvu</option></select><button class="primary-button">搜索</button></form>
    <div class="source-results-heading"><p data-status role="status" aria-live="polite"></p><span>Z-Library</span></div><div class="source-browser"><div data-results><div class="source-invitation">${icon("pages")}<h2>发现下一本好书</h2><p>搜索书名、作者或 ISBN</p></div></div><aside data-detail hidden></aside></div><button data-more hidden class="secondary-button">更多结果</button>`;
  const $ = (selector) => page.querySelector(selector);
  let cursor,
    revision = 0,
    rows = [],
    selected,
    downloading = false;
  const status = (message) => ($("[data-status]").textContent = message);
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
            }),
      });
      if (version !== revision) return;
      rows = more ? [...rows, ...result.rows] : result.rows;
      if (!more) {
        selected = null;
        $("[data-detail]").hidden = true;
      }
      cursor = result.next_cursor;
      $("[data-more]").hidden = !cursor;
      $("[data-results]").innerHTML = rows.length
        ? rows
            .map(
              (row, index) =>
                `<button class="source-result" data-index="${index}"><span class="source-cover" aria-hidden="true"><span>${esc(row.title || "BOOK")}</span><small>${esc(row.format || "BOOK")}</small></span><span><strong>${esc(row.title || "未命名")}</strong><small>${esc([row.author, row.publisher, row.year].filter(Boolean).join(" · "))}</small><small>${esc([row.language, row.size_mb ? row.size_mb + " MB" : ""].filter(Boolean).join(" · "))}</small></span><span>›</span></button>`,
            )
            .join("")
        : "<p>没有找到书籍，请更换关键词。</p>";
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
  $("[data-results]").onclick = async (event) => {
    const button = event.target.closest("[data-index]");
    if (!button || downloading) return;
    selected = rows[Number(button.dataset.index)];
    for (const candidate of $("[data-results]").querySelectorAll(
      "[data-index]",
    ))
      candidate.setAttribute("aria-pressed", String(candidate === button));
    const row = selected;
    $("[data-detail]").hidden = false;
    $("[data-detail]").textContent = "正在读取版本…";
    try {
      const detail = await post("/api/book-source/query", {
        operation: "details",
        ref: row.ref,
      });
      if (selected !== row) return;
      const format = (detail.format || row.format || "").toLowerCase();
      $("[data-detail]").innerHTML =
        `<span class="source-format">${esc(format)}</span><h2>${esc(detail.title || row.title)}</h2><p>${esc(detail.author || row.author || "")}</p><p>${esc([detail.publisher, detail.year, detail.language, detail.pages ? detail.pages + " 页" : ""].filter(Boolean).join(" · "))}</p><p class="source-description">${esc(detail.description || "")}</p><label><input type="checkbox" data-parse ${["pdf", "txt", "djvu"].includes(format) ? "checked" : ""}> 导入后解析文档</label><button data-download class="primary-button">下载并加入书库</button>`;
      $("[data-download]").onclick = () => download(row);
      $("[data-detail]").scrollIntoView({block:"nearest", behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"});
    } catch (error) {
      if (selected === row) $("[data-detail]").textContent = error.message;
    }
  };
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
    open() {
      $("[data-search] input").focus();
    },
  };
}
