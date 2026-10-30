import { escapeHTML, icon } from "./shared.mjs";

export function filterBooks(books, filter, query = "") {
  const term = query.trim().toLocaleLowerCase();
  return books.filter(
    (book) =>
      (filter === "all" ||
        (filter === "pinned" ? book.onShelf : book.shelf === filter)) &&
      `${book.title} ${book.author} ${book.format}`
        .toLocaleLowerCase()
        .includes(term),
  );
}

export function cover(book, small = false) {
  return `<div class="book-cover ${book.shelf === "学习" ? "cover-study" : ""} ${small ? "small-cover" : ""}">${
    book.cover
      ? `<img src="${escapeHTML(book.cover)}" alt="${escapeHTML(book.title)}封面" loading="lazy">`
      : `<span class="cover-format">${escapeHTML(book.format)}</span><span class="cover-stamp" aria-hidden="true">${escapeHTML(Array.from(book.title || "间")[0])}</span><span class="cover-title ${book.title.length > 36 ? "long-title" : ""}">${escapeHTML(book.title)}</span><span class="cover-author">${escapeHTML(book.author)}</span>`
  }</div>`;
}

// Filtering hides keyed cards; changing a star never replaces its focused button or image.
export function reconcileCards(grid, books, visible, cards, create, update) {
  const known = new Set(books.map((book) => book.id));
  for (const [id, card] of cards) {
    if (!known.has(id)) {
      card.remove();
      cards.delete(id);
    }
  }
  for (const book of books) {
    let card = cards.get(book.id);
    if (!card) {
      card = create(book);
      cards.set(book.id, card);
      grid.append(card);
    }
    update(card, book);
    card.hidden = !visible.has(book.id);
  }
}

export function nextVisibleCard(cards, previous) {
  const ordered = [...cards],
    index = ordered.indexOf(previous);
  return (
    ordered.slice(index + 1).find((card) => !card.hidden) ||
    ordered
      .slice(0, Math.max(0, index))
      .reverse()
      .find((card) => !card.hidden)
  );
}

export function createLibraryView(doc) {
  const $ = (id) => doc.getElementById(id);
  const cards = new Map();
  let continueSignature;
  function createCard() {
    const card = doc.createElement("article");
    card.className = "library-book";
    card.innerHTML = `<button class="cover-open"></button><button class="book-more icon-button">${icon("more")}</button><div class="book-card-foot"><div class="book-card-copy"><h3></h3><p></p><div class="book-tags"><span class="book-format"></span><span class="book-tag-separator" aria-hidden="true">·</span><span class="book-status"></span></div><button class="book-process" hidden>文档处理</button></div><button class="shelf-star">${icon("star")}</button></div>`;
    return card;
  }
  function updateCard(card, book) {
    const open = card.querySelector(".cover-open");
    const signature = JSON.stringify([
      book.cover,
      book.title,
      book.author,
      book.shelf,
      book.format,
    ]);
    if (card.dataset.coverSignature !== signature) {
      open.innerHTML = cover(book);
      card.dataset.coverSignature = signature;
    }
    open.dataset.read = book.id;
    open.setAttribute("aria-label", `阅读 ${book.title}`);
    const options = card.querySelector(".book-more");
    options.dataset.options = book.id;
    options.setAttribute("aria-label", `${book.title}的设置`);
    const processing = card.querySelector(".book-process");
    processing.hidden = book.type !== "pdf" || book.localPreparation?.status !== "running";
    processing.dataset.process = book.id;
    processing.setAttribute("aria-label", `处理 PDF 文档 ${book.title}`);
    processing.textContent =
      book.localPreparation?.status === "running"
        ? `划词准备 ${book.localPreparation.completed} / ${book.pages}`
        : "文档处理";
    const title = card.querySelector("h3");
    title.textContent = book.title;
    title.title = book.title;
    card.querySelector("p").textContent = book.author;
    card.querySelector(".book-format").textContent = book.format;
    card.querySelector(".book-status").textContent =
      book.processing === "pending"
        ? book.type === "pdf"
          ? book.processingKind === "mineru"
            ? "解析中"
            : "准备目录…"
          : "处理中…"
        : book.processing === "error"
          ? "待重试"
          : "";
    card.querySelector(".book-tag-separator").hidden = !card.querySelector(".book-status").textContent;
    card.dataset.processing = book.processing || "ready";
    const star = card.querySelector(".shelf-star");
    star.dataset.star = book.id;
    star.setAttribute(
      "aria-label",
      `${book.onShelf ? "移出" : "加入"}常读 ${book.title}`,
    );
    star.setAttribute("aria-pressed", String(!!book.onShelf));
  }
  return {
    render({ books, filter, query, last, progress, detail }) {
      const focusedCard = [...cards.values()].find((card) =>
        card.contains(doc.activeElement),
      );
      const selected = filterBooks(books, filter, query);
      $("library-summary").textContent = query.trim()
        ? `${selected.length} 本`
        : "";
      reconcileCards(
        $("library-grid"),
        books,
        new Set(selected.map((b) => b.id)),
        cards,
        createCard,
        updateCard,
      );
      $("library-empty").hidden = selected.length > 0;
      $("empty-title").textContent = !books.length
        ? "暂无书籍"
        : filter === "pinned" && !query
          ? "暂无常读书籍"
          : "未找到书籍";
      $("empty-action").textContent = books.length
        ? "查看全部书籍"
        : "导入书籍";
      $("empty-action").dataset.emptyAction = books.length ? "clear" : "import";
      if (focusedCard?.hidden)
        (
          nextVisibleCard(cards.values(), focusedCard)?.querySelector(
            ".shelf-star",
          ) ||
          (!selected.length
            ? $("empty-action")
            : doc.querySelector(`[data-filter="${filter}"]`))
        )?.focus({ preventScroll: true });
      $("continue-reading").hidden = !!query.trim() || !last;
      if (last) {
        const fraction = progress(last),
          description = detail(last);
        const signature = JSON.stringify([
          last.id,
          last.cover,
          last.title,
          last.author,
          last.shelf,
          last.layout,
          description,
          fraction,
        ]);
        if (signature !== continueSignature) {
          const canPalm =
            last.type !== "pdf" &&
            !["comic", "pre-paginated"].includes(last.layout);
          $("continue-reading").innerHTML =
            `<article class="continue-card">${cover(last, true)}<div class="continue-copy"><h2>${escapeHTML(last.title)}</h2><p>${escapeHTML(description)}${fraction ? ` · ${Math.round(fraction * 100)}%` : ""}</p></div><div class="continue-actions"><button class="primary-button" data-read="${escapeHTML(last.id)}">继续阅读 ${icon("forward")}</button>${canPalm ? `<button class="secondary-button palm-action" data-palm="${escapeHTML(last.id)}">${icon("palm")}掌上阅读</button>` : ""}</div><div class="continue-progress" style="width:${Math.max(1, fraction * 100)}%"></div></article>`;
          continueSignature = signature;
        }
      }
      doc
        .querySelectorAll("[data-filter]")
        .forEach((button) =>
          button.setAttribute(
            "aria-pressed",
            String(button.dataset.filter === filter),
          ),
        );
    },
  };
}
