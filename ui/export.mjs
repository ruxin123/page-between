import { formatPages } from "./mineru.mjs";

export function downloadFile(result) {
  if (window.webkit?.messageHandlers?.appNative) {
    window.webkit.messageHandlers.appNative.postMessage({
      action: "saveExport",
      path: result.download,
      name: result.name,
    });
  } else {
    const link = document.createElement("a");
    link.href = result.download;
    link.download = result.name;
    document.body.append(link);
    link.click();
    link.remove();
  }
}

export function createBookExport({ post, getBook, toast }) {
  const $ = (id) => document.getElementById(id);
  let book;
  function open(id) {
    if ($("export-submit").disabled) {
      $("export-dialog").showModal();
      return;
    }
    book = getBook(id);
    if (!book) return;
    const pdf = book.type === "pdf";
    $("export-book-title").textContent = book.title;
    $("export-pages-row").hidden = !pdf;
    $("export-pages").required = pdf;
    $("export-pages").value = pdf
      ? formatPages(
          book.enhancedPages?.length
            ? book.enhancedPages
            : Array.from({ length: book.pages }, (_, index) => index + 1),
        )
      : "";
    $("export-policy").textContent = pdf
      ? "已解析页使用可重排文字、公式和表格；尚无文字的页保留原图。导入导出后的 EPUB 时，如果原 PDF 仍在书库，可一键查看原页。"
      : book.format === "EPUB"
        ? "保留原书目录、插图与样式，导出完整 EPUB 副本。"
        : "按章节生成 EPUB。";
    $("export-status").textContent = "";
    $("export-dialog").showModal();
  }
  $("export-all").onclick = () => {
    if (book) $("export-pages").value = `1-${book.pages}`;
  };
  $("export-known").onclick = () => {
    if (book?.enhancedPages?.length)
      $("export-pages").value = formatPages(book.enhancedPages);
    else toast("这本书尚无精细解析结果，可保留原页或先执行解析。");
  };
  $("export-form").onsubmit = async (event) => {
    event.preventDefault();
    if (!book || $("export-submit").disabled) return;
    const source = book;
    $("export-submit").disabled = true;
    $("export-status").textContent =
      "正在准备 EPUB，可继续阅读，完成后选择保存位置…";
    try {
      const result = await post("/api/export/epub", {
        book: source.id,
        pages: $("export-pages").value,
      });
      downloadFile(result);
      $("export-status").textContent = result.fallbackPages.length
        ? `已准备 EPUB，其中 ${result.fallbackPages.length} 页保留原图。`
        : result.fallbackObjects
          ? `EPUB 已准备，其中 ${result.fallbackObjects} 个复杂区块保留原图。`
          : result.compatibilityUpdated
            ? "已准备，可保存。"
            : "已准备，可保存。";
    } catch (error) {
      $("export-status").textContent = error.message;
    } finally {
      $("export-submit").disabled = false;
    }
  };
  return { open };
}
