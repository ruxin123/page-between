import { escapeHTML } from "./shared.mjs";
import { textChapterIndex } from "../core.mjs";

export function createChapterEditor({
  post,
  getBook,
  beforeChange,
  changed,
  toast,
}) {
  const $ = (id) => document.getElementById(id);
  let book,
    index = 1,
    split = null,
    busy = false;

  function list() {
    const query = $("chapters-search").value.trim().toLocaleLowerCase();
    $("chapters-list").innerHTML =
      book.chapters
        .map((chapter, number) => ({ chapter, number: number + 1 }))
        .filter(({ chapter }) =>
          chapter.title.toLocaleLowerCase().includes(query),
        )
        .map(
          ({ chapter, number }) =>
            `<button type="button" data-chapter-edit="${number}" aria-current="${number === index}" ${busy ? "disabled" : ""}><small>${number}</small><span>${escapeHTML(chapter.title)}</span></button>`,
        )
        .join("") || '<p class="setting-note">没有找到这个章节。</p>';
  }

  function select(number) {
    index = Math.max(1, Math.min(number, book.chapters.length));
    $("chapters-title").value = split?.title || book.chapters[index - 1].title;
    $("chapters-current").textContent = split
      ? "从选中位置开始新章节"
      : `第 ${index} 个章节`;
    $("chapters-save").textContent = split ? "设为章节起点" : "保存标题";
    $("chapters-merge").hidden = !!split;
    $("chapters-merge").disabled = index === 1 || !book.parseEnabled;
    $("chapters-save").disabled = !book.parseEnabled;
    $("chapters-undo").disabled = !book.previousContentUrl;
    $("chapters-auto").textContent = book.parseEnabled
      ? "重新识别目录"
      : "识别章节并启用导航";
    $("chapters-preview").hidden = !split;
    $("chapters-preview").textContent = split?.text || "";
    $("chapters-browser").hidden = !!split;
    $("chapters-restore").hidden = !!split;
    $("chapters-note").textContent = book.parseEnabled
      ? "改标题或合并相邻章节；在正文选中起点，还可以拆分章节。原文件与阅读记录保留。"
      : "当前使用全文阅读。可以先识别章节并启用导航，再调整目录。";
    list();
  }

  function open(id, position = {}, selection = null) {
    if (busy) return toast("正在保存目录，请稍候。");
    book = getBook(id);
    if (!book || book.type !== "txt") return;
    if (book.processing === "pending")
      return toast("正在整理这本书的目录，请完成后再调整。");
    split = selection;
    $("chapters-book").textContent = book.title;
    $("chapters-search").value = "";
    $("chapters-status").textContent = "";
    $("chapters-reset").open = false;
    select(
      Number.isFinite(position.sourceOffset)
        ? textChapterIndex(book.chapters, position.sourceOffset)
        : position.index || 1,
    );
    $("chapters-dialog").showModal();
    $("chapters-title").focus();
    $("chapters-title").select();
  }

  async function apply(action) {
    if (busy || !book) return;
    if (
      ["rename", "split"].includes(action) &&
      !$("chapters-form").reportValidity()
    )
      return;
    const source = book,
      selected = index;
    busy = true;
    $("chapters-controls").disabled = true;
    $("chapters-restore").inert = true;
    $("chapters-status").textContent = "正在保存目录…";
    list();
    try {
      const resume = await beforeChange(source.id);
      const result = await post(`/api/books/${source.id}/chapters`, {
        action,
        index: selected,
        revision: source.structureRevision || "",
        title: $("chapters-title").value.trim(),
        offset: split?.offset,
      });
      book = result.book;
      await changed(source.id, resume);
      if (action === "split") {
        $("chapters-dialog").close();
        toast("已设为章节起点，阅读位置已保留。", { kind: "success" });
      } else {
        select(
          Math.min(
            action === "merge" ? selected - 1 : selected,
            book.chapters.length,
          ),
        );
        $("chapters-status").textContent =
          action === "undo"
            ? "已恢复上一版目录。"
            : "目录已保存，阅读位置已保留。";
      }
    } catch (error) {
      $("chapters-status").textContent = error.message;
    } finally {
      busy = false;
      $("chapters-controls").disabled = false;
      $("chapters-restore").inert = false;
      list();
    }
  }

  $("chapters-search").oninput = list;
  $("chapters-list").onclick = (event) => {
    const button = event.target.closest("[data-chapter-edit]");
    if (button && !busy) {
      select(Number(button.dataset.chapterEdit));
      $("chapters-status").textContent = "";
    }
  };
  $("chapters-form").onsubmit = (event) => {
    event.preventDefault();
    apply(split ? "split" : "rename");
  };
  $("chapters-merge").onclick = () => apply("merge");
  $("chapters-auto").onclick = () => apply("reset");
  $("chapters-undo").onclick = () => apply("undo");
  return { open };
}
