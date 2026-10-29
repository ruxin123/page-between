import { escapeHTML as esc } from "./shared.mjs";

export function createBookSource({ api, post, refresh }) {
  const dialog = document.createElement("dialog");
  dialog.className = "book-source-dialog";
  dialog.innerHTML = `<header><div><small>BOOK DISCOVERY</small><h1>找下一本书</h1></div><button data-close aria-label="关闭">×</button></header>
    <form data-search><input name="query" type="search" required maxlength="500" placeholder="书名、作者或 ISBN" aria-label="搜索书籍"><select name="format" aria-label="文件格式"><option value="">所有格式</option><option>epub</option><option>pdf</option><option>txt</option><option>mobi</option><option>azw3</option><option>djvu</option></select><button class="primary-button">搜索</button></form>
    <details data-settings><summary>书源设置</summary><form data-account><label>邮箱<input name="email" type="email" required autocomplete="username"></label><label>密码<input name="password" type="password" autocomplete="current-password" placeholder="留空保留已保存密码"></label><button class="secondary-button">保存账号</button></form><p data-component></p><button data-install class="secondary-button" hidden>安装书源组件</button><a href="https://z-lib.sk/" target="_blank" rel="noopener noreferrer">在网站中打开 ↗</a></details>
    <p data-status role="status" aria-live="polite"></p><div class="source-browser"><div data-results><p class="source-invitation">输入书名，选择适合阅读的版本。</p></div><aside data-detail hidden></aside></div><button data-more hidden class="secondary-button">更多结果</button>`;
  document.body.append(dialog);
  const $ = (s) => dialog.querySelector(s);
  let cursor,
    revision = 0,
    rows = [],
    selected,
    downloading = false;
  const status = (message) => ($("[data-status]").textContent = message);
  $("[data-close]").onclick = () => dialog.close();
  $("[data-install]").onclick = async () => {
    $("[data-install]").disabled = true;
    try {
      let task = await post("/api/book-source/install", {});
      while (task.status === "running") {
        status("正在安装书源组件…");
        await new Promise((resolve) => setTimeout(resolve, 1500));
        task = await api("/api/book-source/component");
      }
      if (task.status === "error") throw Error(task.error);
      $("[data-install]").hidden = true;
      $("[data-component]").textContent = "密码保存在 macOS 钥匙串";
      status("组件已安装");
    } catch (error) {
      status(error.message);
    } finally {
      $("[data-install]").disabled = false;
    }
  };
  $("[data-account]").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await post("/api/book-source/settings", {
        email: form.elements.email.value,
        password: form.elements.password.value,
      });
      form.elements.password.value = "";
      status("账号已保存");
      $("[data-settings]").open = false;
    } catch (error) {
      status(error.message);
    }
  };
  $("[data-account]").addEventListener(
    "invalid",
    () => status("请填写有效的账号邮箱。"),
    true,
  );
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
                `<button class="source-result" data-index="${index}"><span class="source-format">${esc(row.format || "BOOK")}</span><span><strong>${esc(row.title || "未命名")}</strong><small>${esc([row.author, row.publisher, row.year].filter(Boolean).join(" · "))}</small><small>${esc([row.language, row.size_mb ? row.size_mb + " MB" : ""].filter(Boolean).join(" · "))}</small></span><span>›</span></button>`,
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
        dialog.close();
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
    async open(showSettings = false) {
      if (!dialog.open) dialog.showModal();
      status("");
      try {
        const config = await api("/api/book-source/settings");
        $("[data-install]").hidden = config.installed;
        $("[data-account]").elements.email.value = config.email;
        $("[data-settings]").open = showSettings || !config.hasPassword;
        $("[data-component]").textContent = config.installed
          ? "密码保存在 macOS 钥匙串"
          : "首次安装需要 Node.js 22+ 和 uv";
      } catch (error) {
        status(error.message);
      }
      $(
        showSettings
          ? "[data-account] input[name=email]"
          : "[data-search] input",
      ).focus();
    },
  };
}
