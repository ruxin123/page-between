export function taskEntries(books, jobs) {
  const latest = new Map();
  for (const job of jobs) if (!latest.has(job.book)) latest.set(job.book, job);
  const entries = books.map((book) => {
    const job = latest.get(book.id);
    const disabled = book.parseEnabled === false && book.type !== "txt";
    // The book records current state; historical errors are not active alerts.
    const status = disabled
      ? "ready"
      : book.processing === "pending"
        ? "running"
        : job?.status === "paused"
          ? "paused"
          : ["ready", "error"].includes(book.processing)
            ? book.processing
            : job?.status || "ready";
    return {
      book: book.id,
      kind: job?.kind || "local",
      pages: job?.pages || [],
      title: book.title,
      status,
      phase: disabled
        ? "已关闭增强解析，沿用原书内容。"
        : job?.status === status
          ? job.phase
          : book.processingNote ||
            (book.type === "epub"
              ? "已沿用原书目录、插图与正文。"
              : "已导入，可直接阅读。"),
    };
  });
  for (const book of books) {
    const local = book.localPreparation;
    if (
      book.type !== "pdf" ||
      !book.parseEnabled ||
      !local ||
      (!local.activePage &&
        !["running", "paused", "error"].includes(local.status))
    )
      continue;
    entries.push({
      book: book.id,
      kind: "selection",
      pages: [],
      title: book.title + " · 本地划词",
      status:
        local.status === "error"
          ? "error"
          : local.status === "paused"
            ? "paused"
            : "running",
      phase:
        `${local.completed} / ${local.total} 页已准备。` +
        (local.activePage
          ? `正在准备第 ${local.activePage} 页。`
          : local.status === "paused"
            ? "整本准备已暂停，已完成页保留。"
            : local.error || "在本机后台准备，结果随书保存。"),
    });
  }
  return entries;
}
