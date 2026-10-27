// Page bitmaps are drawn offscreen; a hidden window must not wait for animation frames.
export function renderPdfBitmap(page, options) {
  const task = page.render(options);
  const internal = task._internalRenderTask;
  // shortcut: this scheduler flag belongs to our vendored PDF.js; verify it on upgrades.
  if (!internal || typeof internal._useRequestAnimationFrame !== "boolean") {
    task.cancel();
    throw new Error("PDF 绘制组件不兼容，请更新应用。");
  }
  internal._useRequestAnimationFrame = false;
  task.onContinue = (resume) => setTimeout(resume, 0);
  return task;
}
