export function taskEntries(books, jobs) {
  const latest = new Map();
  for (const job of jobs) if (!latest.has(job.book)) latest.set(job.book, job);
  return books.map((book) => {
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
}
