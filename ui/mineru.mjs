export function formatPages(pages) {
  const parts = [];
  for (let i = 0; i < pages.length; i++) {
    const start = pages[i];
    let end = start;
    while (pages[i + 1] === end + 1) end = pages[++i];
    parts.push(start === end ? String(start) : start + "-" + end);
  }
  return parts.join(",");
}

export function createDocumentParsing({
  document,
  api,
  post,
  getBook,
  getPosition,
  refresh,
  toast,
}) {
  const $ = (id) => document.getElementById(id);
  let book,
    busy = false;
  const nearby = () => {
    const start = getPosition(book.id)?.index || 1;
    $("cloud-pages").value = start + "-" + Math.min(book.pages, start + 5);
  };
  async function open(id, pages) {
    if (busy) return;
    book = getBook(id);
    if (!book || book.type !== "pdf") return;
    $("book-dialog").close();
    $("jobs-dialog").close();
    $("cloud-book-title").textContent = book.title;
    $("cloud-page-count").textContent =
      `本书共 ${book.pages} 页，使用文件页序。${book.enhancedPages?.length ? `已增强 ${book.enhancedPages.length} 页。` : ""}`;
    if (pages?.length) $("cloud-pages").value = formatPages(pages);
    else nearby();
    $("cloud-fresh").checked = false;
    $("cloud-start").disabled = true;
    $("cloud-status").textContent = "正在检查本机服务设置…";
    $("cloud-dialog").showModal();
    try {
      const data = await api("/api/settings");
      $("cloud-start").disabled = !data.services.mineru.ready;
      $("cloud-status").textContent = data.services.mineru.ready
        ? "将使用已配置的 MinerU 服务。解析额度与处理时间由服务方提供。"
        : "请先配置 MinerU 服务。";
    } catch (error) {
      $("cloud-status").textContent = error.message;
    }
  }
  $("cloud-current").onclick = nearby;
  $("cloud-all").onclick = () => {
    $("cloud-pages").value = "1-" + book.pages;
  };
  $("cloud-settings").onclick = () => $("cloud-dialog").close();
  $("cloud-form").onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    $("cloud-start").disabled = true;
    try {
      await post("/api/jobs/mineru", {
        book: book.id,
        pages: $("cloud-pages").value,
        fresh: $("cloud-fresh").checked,
      });
      $("cloud-dialog").close();
      await refresh();
      toast("云解析已在后台开始，可继续阅读原书。", { kind: "success" });
    } catch (error) {
      $("cloud-status").textContent = error.message;
    } finally {
      busy = false;
      $("cloud-start").disabled = false;
    }
  };
  async function pause(id) {
    try {
      const result = await post("/api/jobs/pause", { book: id });
      toast(
        result.paused ? "正在暂停，当前请求结束后保留进度。" : "任务已经结束。",
        { kind: "success" },
      );
      await refresh();
    } catch (error) {
      toast(error.message, { kind: "error" });
    }
  }
  return { open, pause };
}
