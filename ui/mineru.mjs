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
  let localError = "";
  let book,
    snapshot,
    busy = false,
    configured = false,
    resumeMode = false,
    timer,
    revision = 0;
  const text = (id, value) => {
    if ($(id).textContent !== value) $(id).textContent = value;
  };
  const range = (value) => {
    $("cloud-pages").value = value;
    resumeMode = false;
  };
  const nearby = () => {
    const start = getPosition(book.id)?.index || 1;
    range(start + "-" + Math.min(book.pages, start + 5));
  };
  function render() {
    if (!snapshot) return;
    const local = snapshot.local,
      cloud = snapshot.mineru;
    text("local-preparation-count", `${local.completed} / ${local.total} 页`);
    $("local-preparation-progress").max = local.total;
    $("local-preparation-progress").value = local.completed;
    text(
      "local-preparation-status",
      local.status === "ready"
        ? ""
        : local.status === "paused"
          ? "已暂停。"
          : local.status === "error"
            ? local.failedPages.length
              ? `${local.failedPages.length} 页未成功，已完成页保留。${local.error}`
              : local.error
            : local.activePage
              ? `正在准备第 ${local.activePage} 页。`
              : local.status === "running"
                ? "准备中…"
                : "",
    );
    text(
      "local-prepare-all",
      local.status === "ready"
        ? "已全部准备"
        : local.status === "paused"
          ? "继续准备整本"
          : local.status === "error"
            ? "重试未完成页"
            : "提前准备整本",
    );
    $("local-prepare-all").disabled =
      busy || ["running", "ready"].includes(local.status);
    $("local-prepare-pause").hidden = local.status !== "running";
    $("local-prepare-pause").disabled = busy;
    text("cloud-progress-count", `${cloud.completed} / ${cloud.total} 页`);
    $("cloud-progress").max = cloud.total;
    $("cloud-progress").value = cloud.completed;
    text(
      "cloud-job-status",
      cloud.status === "running"
        ? cloud.phase
        : cloud.status === "paused"
          ? `已暂停。${cloud.phase}`
          : cloud.status === "error"
            ? cloud.phase
            : "",
    );
    const running = cloud.status === "running";
    $("cloud-fill").disabled =
      busy || !configured || running || cloud.completed === cloud.total;
    $("cloud-resume").hidden =
      !["paused", "error"].includes(cloud.status) || !cloud.pages.length;
    $("cloud-resume").disabled = busy || !configured;
    $("cloud-pause").hidden = !running;
    $("cloud-pause").disabled = busy;
    $("cloud-start").disabled = busy || !configured || running;
    text("cloud-start", resumeMode ? "继续云解析" : "开始所选页解析");
    if (localError) text("local-preparation-status", localError);
  }
  async function loadStatus(expected = revision) {
    const value = await api(
      "/api/pdf/preparation?book=" + encodeURIComponent(book.id),
    );
    if (
      expected !== revision ||
      !$("cloud-dialog").open ||
      value.book !== book.id
    )
      return;
    snapshot = value;
    render();
  }
  async function poll(expected) {
    try {
      await loadStatus(expected);
    } catch (error) {
      if (expected === revision && $("cloud-dialog").open)
        text("cloud-status", error.message);
    }
    if (expected === revision && $("cloud-dialog").open)
      timer = setTimeout(() => poll(expected), 1500);
  }
  async function open(id, pages) {
    if (busy) return;
    book = getBook(id);
    if (!book || book.type !== "pdf") return;
    const expected = ++revision;
    clearTimeout(timer);
    snapshot = null;
    localError = "";
    configured = false;
    resumeMode = !!pages?.length;
    $("book-dialog").close();
    $("jobs-dialog").close();
    text("cloud-book-title", book.title);
    if (pages?.length) $("cloud-pages").value = formatPages(pages);
    else nearby();
    $("cloud-fresh").checked = false;
    for (const id of ["local-prepare-all", "cloud-fill", "cloud-start"])
      $(id).disabled = true;
    text("cloud-status", "正在检查本机服务设置…");
    $("cloud-dialog").showModal();
    try {
      const [settings] = await Promise.all([
        api("/api/settings"),
        loadStatus(expected),
      ]);
      if (expected !== revision || !$("cloud-dialog").open) return;
      configured = settings.services.mineru.ready;
      text(
        "cloud-status",
        configured ? "" : "请先配置 MinerU。",
      );
      render();
    } catch (error) {
      if (expected === revision) text("cloud-status", error.message);
    }
    if (expected === revision && $("cloud-dialog").open)
      timer = setTimeout(() => poll(expected), 1500);
  }
  $("cloud-dialog").addEventListener("close", () => {
    revision++;
    clearTimeout(timer);
  });
  $("cloud-pages").addEventListener("input", () => {
    resumeMode = false;
    render();
  });
  $("cloud-fresh").addEventListener("change", () => {
    resumeMode = false;
    render();
  });
  $("cloud-current").onclick = nearby;
  $("cloud-all").onclick = () => range("1-" + book.pages);
  $("cloud-settings").onclick = () => $("cloud-dialog").close();
  async function localAction(action) {
    if (busy) return;
    localError = "";
    busy = true;
    render();
    try {
      await post("/api/pdf/prepare", { book: book.id, action });
      await refresh();
      await loadStatus();
      toast(
        action === "pause"
          ? "已暂停。"
          : "已开始准备。",
        { kind: "success" },
      );
    } catch (error) {
      localError = error.message;
      text("local-preparation-status", error.message);
    } finally {
      busy = false;
      render();
    }
  }
  $("local-prepare-all").onclick = () => localAction("all");
  $("local-prepare-pause").onclick = () => localAction("pause");
  async function startCloud() {
    if (busy || !configured || snapshot?.mineru.status === "running") return;
    busy = true;
    render();
    try {
      await post("/api/jobs/mineru", {
        book: book.id,
        pages: $("cloud-pages").value,
        fresh: $("cloud-fresh").checked,
        resume: resumeMode && !$("cloud-fresh").checked,
      });
      resumeMode = false;
      await refresh();
      await loadStatus();
      toast("已开始解析。", { kind: "success" });
    } catch (error) {
      text("cloud-status", error.message);
    } finally {
      busy = false;
      render();
    }
  }
  $("cloud-form").onsubmit = (event) => {
    event.preventDefault();
    startCloud();
  };
  $("cloud-fill").onclick = () => {
    range("1-" + book.pages);
    $("cloud-fresh").checked = false;
    startCloud();
  };
  $("cloud-resume").onclick = () => {
    range(formatPages(snapshot.mineru.pages));
    resumeMode = true;
    $("cloud-fresh").checked = false;
    startCloud();
  };
  async function pause(id) {
    if (busy) return;
    busy = true;
    render();
    try {
      const result = await post("/api/jobs/pause", { book: id });
      toast(result.paused ? "正在暂停，已完成页保留。" : "任务已经结束。", {
        kind: "success",
      });
      await refresh();
      if ($("cloud-dialog").open && book?.id === id) await loadStatus();
    } catch (error) {
      toast(error.message, { kind: "error" });
    } finally {
      busy = false;
      render();
    }
  }
  $("cloud-pause").onclick = () => pause(book.id);
  return { open, pause };
}
