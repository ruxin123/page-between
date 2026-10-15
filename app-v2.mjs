import * as pdfjs from "/assets/vendor/pdf.mjs";
import { clamp, chapterProgress, palmTypography } from "/core.mjs";
import { PageLayout } from "/page-layout.mjs?v=2.12";

pdfjs.GlobalWorkerOptions.workerSrc = "/assets/vendor/pdf.worker.mjs";
const $ = (id) => document.getElementById(id);
const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const paths = {
  library: "M4 4h6v16H4zM14 4h6v16h-6zM4 8h6M14 8h6",
  shelf: "M4 4v16h16V4M4 13h16M8 5v8M12 7v6M16 5v8",
  import: "M12 3v12M7 10l5 5 5-5M4 16v5h16v-5",
  plus: "M12 5v14M5 12h14",
  search: "M21 21l-5-5M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14",
  settings: "M4 7h16M4 17h16M8 4v6M16 14v6",
  back: "M15 5l-7 7 7 7",
  forward: "M9 5l7 7-7 7",
  toc: "M8 5h12M8 12h12M8 19h12M3 5h.1M3 12h.1M3 19h.1",
  bookmark: "M6 3h12v18l-6-4-6 4z",
  palm: "M7 2h10v20H7zM10 18h4",
  focus: "M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5",
  more: "M5 12h.1M12 12h.1M19 12h.1",
  close: "M6 6l12 12M18 6L6 18",
  copy: "M8 8h12v13H8zM16 8V3H3v13h5",
  image: "M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 5M17 8h.1",
  ask: "M4 4h16v12H9l-5 4zM8 8h8M8 12h5",
  timer: "M9 2h6M12 8v5l3 2M12 22a8 8 0 1 0 0-16 8 8 0 0 0 0 16",
  star: "M12 3l2.8 5.8 6.4.9-4.6 4.5 1.1 6.4L12 17.6l-5.7 3 1.1-6.4L2.8 9.7l6.4-.9z",
  pages: "M3 4h7l2 2 2-2h7v16h-7l-2 2-2-2H3zM12 6v16",
  scroll: "M7 3h10v18H7zM10 7h4M10 11h4M10 15h4",
  pin: "M8 3h8l-1 7 4 4H5l4-4zM12 14v8",
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.library}"></path></svg>`;
document
  .querySelectorAll("[data-icon]")
  .forEach((element) => (element.innerHTML = icon(element.dataset.icon)));
const fontFamilies = {
  "han-serif": "ReaderHanSerif",
  wenkai: "ReaderWenKai",
  "han-sans": "ReaderHanSans",
  literata: "ReaderLiterata",
  "source-serif": "ReaderSourceSerif",
  georgia: "Georgia",
  system: "-apple-system",
};
const query = new URLSearchParams(window.location.search);
const palm = query.get("mode") === "palm";
const native = !!window.webkit?.messageHandlers?.readerNative;
const writer = crypto.randomUUID();
const defaults = {
  theme: "paper",
  zhFont: "han-serif",
  enFont: "literata",
  fontSize: 21,
  lineHeight: 1.95,
  textWidth: 680,
  pdfZoom: 100,
  pdfTint: true,
  palmScale: 1,
  textMode: "pages",
  palmMode: "pages",
  pdfMode: "scroll",
};
let prefs = { ...defaults },
  books = [],
  jobs = [],
  positions = {},
  bookmarks = [],
  current,
  location,
  route = "library",
  shelfFilter = "all";
let renderRevision = 0,
  preferenceRevision = 0,
  renderTask,
  textLayerTask,
  epubObserver,
  currentSelection,
  questionContext,
  lastAnchor,
  pendingAnchor;
let saveTimer,
  toastTimer,
  ocrTimer,
  timerDeadline = 0,
  timerRemaining = 1500,
  timerRunning = false;
let stateRevision = 0,
  libraryRevision = 0,
  lastInput = 0,
  history = [],
  importFiles = [],
  editingBook,
  readerReady = false;
let stateQueue = Promise.resolve(),
  restoringPosition = false,
  restoreTimer;
function restorePosition(action) {
  restoringPosition = true;
  clearTimeout(restoreTimer);
  action();
  restoreTimer = setTimeout(() => {
    restoringPosition = false;
  }, 220);
}
let pagination,
  flipBusy = false,
  retainedAnchor = null;
const pdfs = new Map(),
  ocrCache = new Map();
document.body.dataset.readerBuild = "2.12";
document.body.dataset.mode = palm ? "palm" : "standard";
document.body.dataset.native = String(native);

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "操作没有完成，请重试。");
  return data;
}
function post(path, value) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 3000);
}
function postState(patch) {
  stateQueue = stateQueue
    .catch(() => {})
    .then(() => post("/api/state", { ...patch, writer }))
    .then((data) => {
      stateRevision = Math.max(stateRevision, data.revision || 0);
      return data;
    });
  return stateQueue;
}
function flatToc(items) {
  return items.flatMap((item) => [item, ...flatToc(item.children || [])]);
}
function count(book) {
  return book.type === "pdf" ? book.pages : book.chapters.length;
}
function chapterTitle(book = current, index = location?.index) {
  if (!book) return "";
  if (book.type !== "pdf")
    return book.chapters[clamp(index, 1, count(book)) - 1]?.title || book.title;
  return (
    flatToc(book.toc || [])
      .filter((item) => item.index && item.index <= index)
      .sort((a, b) => a.index - b.index)
      .at(-1)?.title || "原书页面"
  );
}
function initialLocation(book) {
  const saved = positions[book.id] || {};
  let index = clamp(saved.index || 1, 1, count(book));
  if (book.type === "txt" && Number.isFinite(saved.sourceOffset)) {
    const found = book.chapters.findLastIndex(
      (chapter) => (chapter.sourceOffset || 0) <= saved.sourceOffset,
    );
    if (found >= 0) index = found + 1;
  }
  return {
    ...saved,
    index,
    top: Math.max(0, Number(saved.top) || 0),
    fragment: saved.fragment || "",
  };
}
function progressFor(book) {
  return clamp(positions[book.id]?.progress || 0, 0, 1);
}
function cover(book, small = false) {
  return `<div class="book-cover ${book.shelf === "学习" ? "cover-study" : ""} ${small ? "small-cover" : ""}">${book.cover ? `<img src="${escapeHTML(book.cover)}" alt="${escapeHTML(book.title)}封面" loading="lazy">` : `<span class="cover-title">${escapeHTML(book.title)}</span><span class="cover-author">${escapeHTML(book.author)}</span>`}</div>`;
}

function renderLibrary() {
  const onShelf = route === "shelf";
  $("library-title").textContent = onShelf ? "书架" : "书库";
  $("library-eyebrow").textContent = onShelf ? "ON YOUR SHELF" : "LIBRARY";
  const collection = books.filter((book) => !onShelf || book.onShelf);
  $("library-summary").textContent = onShelf
    ? `${collection.length} 本常读书籍 · 在书库中点击星标即可加入`
    : `${books.length} 本书籍 · 原文件保存在本机`;
  const text = $("library-search").value.trim().toLocaleLowerCase();
  const selected = collection.filter(
    (book) =>
      (shelfFilter === "all" || book.shelf === shelfFilter) &&
      `${book.title} ${book.author} ${book.format}`
        .toLocaleLowerCase()
        .includes(text),
  );
  $("library-grid").innerHTML = selected
    .map(
      (book) =>
        `<article class="library-book"><button class="cover-open" data-read="${book.id}" aria-label="阅读 ${escapeHTML(book.title)}">${cover(book)}</button><button class="book-more icon-button" data-options="${book.id}" aria-label="${escapeHTML(book.title)}的设置">${icon("more")}</button><div class="book-card-foot"><div class="book-card-copy"><h3>${escapeHTML(book.title)}</h3><p>${escapeHTML(book.author)}</p><div class="book-tags"><span>${escapeHTML(book.format)}</span><span>·</span><span>${book.processing === "pending" ? "目录准备中" : book.type === "epub" ? "原书排版" : book.type === "pdf" ? "原书版面" : `${book.chapters.length} 章`}</span></div></div><button class="shelf-star" data-star="${book.id}" aria-label="${book.onShelf ? "移出" : "加入"}书架 ${escapeHTML(book.title)}" aria-pressed="${!!book.onShelf}">${icon("star")}</button></div></article>`,
    )
    .join("");
  $("library-empty").hidden = selected.length > 0;
  $("library-empty").textContent =
    onShelf && !collection.length
      ? "把常读的书加入书架，在这里留一个位置。"
      : "没有找到这本书。可以换个关键词，或导入一本新书。";
  const last =
    books.find((book) => book.id === current?.id) ||
    books.find((book) => positions[book.id]) ||
    books[0];
  $("continue-reading").innerHTML =
    !text && last
      ? `<article class="continue-card">${cover(last, true)}<div class="continue-copy"><small>继续阅读</small><h2>${escapeHTML(last.title)}</h2><p>${escapeHTML(chapterTitle(last, positions[last.id]?.index || 1))}${progressFor(last) ? ` · ${Math.round(progressFor(last) * 100)}%` : ""}</p></div><div class="continue-actions"><button class="primary-button" data-read="${last.id}">翻开书页 ${icon("forward")}</button>${last.type !== "pdf" && last.layout !== "comic" ? `<button class="icon-button" data-palm="${last.id}" aria-label="掌上阅读 ${escapeHTML(last.title)}" title="掌上阅读">${icon("palm")}</button>` : ""}</div><div class="continue-progress" style="width:${Math.max(1, progressFor(last) * 100)}%"></div></article>`
      : "";
  document
    .querySelectorAll("[data-filter]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.filter === shelfFilter),
      ),
    );
}
function renderJobs() {
  $("running-count").textContent =
    jobs.filter((job) => job.status === "running").length || "";
  const entries = jobs.length
    ? jobs
    : books.map((book) => ({
        title: book.title,
        status: book.processing === "pending" ? "running" : "ready",
        phase:
          book.type === "epub"
            ? "已沿用原书目录、插图与正文。"
            : book.processingNote || "已导入，可直接阅读。",
        book: book.id,
      }));
  $("import-jobs").innerHTML = entries
    .map(
      (job) =>
        `<article class="job-row"><span class="job-label ${job.status}">${job.status === "running" ? "准备中" : job.status === "error" ? "待处理" : "可阅读"}</span><div class="job-copy"><strong>${escapeHTML(job.title)}</strong><p>${escapeHTML(job.phase)}</p></div><button class="secondary-button" data-read="${job.book}">阅读</button></article>`,
    )
    .join("");
}

function settingsMarkup() {
  const pdf = current?.type === "pdf" && route === "reader";
  const themes = [
    ["paper", "清纸", "#fffefa"],
    ["sage", "雾松", "#e4eddc"],
    ["blue", "暮蓝", "#e4ecf6"],
    ["night", "夜墨", "#1c2c20"],
  ];
  const select = (label, key, options) =>
    `<label class="setting-row">${label}<select data-pref="${key}">${options.map(([value, title]) => `<option value="${value}" ${prefs[key] === value ? "selected" : ""}>${title}</option>`).join("")}</select></label>`;
  const range = (label, key, min, max, step, output) =>
    `<label class="setting-range"><span>${label}<output data-output="${key}">${output}</output></span><input data-pref="${key}" type="range" min="${min}" max="${max}" step="${step}" value="${prefs[key]}"></label>`;
  return `<section class="settings-section"><h2>浏览方式</h2>${select(
    pdf ? "PDF 阅读" : palm ? "掌上窗口" : "文字阅读",
    pdf ? "pdfMode" : palm ? "palmMode" : "textMode",
    pdf
      ? [
          ["scroll", "连续滚动"],
          ["pages", "单页翻阅"],
        ]
      : [
          ["pages", "动画翻页"],
          ["scroll", "连续滚动"],
        ],
  )}${
    route === "settings"
      ? select("PDF 阅读", "pdfMode", [
          ["scroll", "连续滚动"],
          ["pages", "单页翻阅"],
        ]) +
        select("掌上窗口", "palmMode", [
          ["pages", "动画翻页"],
          ["scroll", "连续滚动"],
        ])
      : ""
  }<p class="setting-note">${pdf ? "保留原书页面，目录和文字选择随页可用。" : "翻页时可使用左右方向键、空格、触控板，或底部翻页按钮。"}</p></section><section class="settings-section"><h2>阅读主题</h2><div class="theme-choices">${themes.map(([theme, title, color]) => `<button data-theme="${theme}" aria-pressed="${prefs.theme === theme}"><span class="theme-circle" style="background:${color}"></span>${title}</button>`).join("")}</div></section>${
    pdf
      ? `<section class="settings-section"><h2>原书版面</h2><p class="setting-note">保留原书字体和排版，通过缩放调整大小。</p>${range("页面缩放", "pdfZoom", 75, 180, 5, `${prefs.pdfZoom}%`)}<button class="secondary-button" data-fit style="margin-top:15px">适合页面宽度</button><label class="setting-check">随主题柔化页面<input data-pref="pdfTint" type="checkbox" ${prefs.pdfTint ? "checked" : ""}></label></section>`
      : `<section class="settings-section"><h2>字里行间</h2>${select(
          "中文字体",
          "zhFont",
          [
            ["han-serif", "思源宋体"],
            ["wenkai", "霞鹜文楷"],
            ["han-sans", "思源黑体"],
            ["system", "系统字体"],
          ],
        )}${select("英文字体", "enFont", [
          ["literata", "Literata"],
          ["source-serif", "Source Serif 4"],
          ["georgia", "Georgia"],
          ["system", "系统字体"],
        ])}${palm ? range("字号偏好", "palmScale", 0.85, 1.25, 0.05, `${Math.round(prefs.palmScale * 100)}%`) : range("字号", "fontSize", 16, 30, 1, `${prefs.fontSize} px`)}${!palm ? range("行距", "lineHeight", 1.5, 2.4, 0.05, prefs.lineHeight.toFixed(2)) + range("正文宽度", "textWidth", 480, 860, 20, `${prefs.textWidth} px`) : `<p class="setting-note adaptive-size-note">随窗口调整，当前 ${actualSize().toFixed(1)} px。</p>`}</section>`
  }<section class="settings-section"><h2>掌上阅读</h2>${palm && native ? '<div class="window-sizes"><button class="secondary-button" data-window-size="compact">小巧</button><button class="secondary-button" data-window-size="standard">标准</button></div>' : ""}<p class="setting-note">独立小窗，默认置顶。窗口缩小时，字号会同步调整；阅读位置与主阅读器共享。</p><p class="setting-note">聚焦小窗：← / → / 空格<br>后台翻页：⌃⌥⌘← / ⌃⌥⌘→</p></section>`;
}
function renderSettings() {
  $("global-settings").innerHTML = settingsMarkup();
  $("quick-settings").innerHTML = settingsMarkup();
}
function actualSize() {
  return palm
    ? clamp(
        palmTypography(innerWidth, innerHeight, prefs.fontSize).size *
          prefs.palmScale,
        10.5,
        25,
      )
    : prefs.fontSize;
}
function applyPreferences() {
  document.body.dataset.theme = prefs.theme;
  const style = document.documentElement.style;
  style.setProperty(
    "--zh-font",
    fontFamilies[prefs.zhFont] || fontFamilies["han-serif"],
  );
  style.setProperty(
    "--en-font",
    fontFamilies[prefs.enFont] || fontFamilies.literata,
  );
  style.setProperty("--reading-size", `${actualSize()}px`);
  style.setProperty("--reading-line", palm ? 1.65 : prefs.lineHeight);
  style.setProperty("--reading-width", `${prefs.textWidth}px`);
  $("pdf-paper").classList.toggle("tinted", prefs.pdfTint);
  document
    .querySelectorAll(".adaptive-size-note")
    .forEach(
      (note) =>
        (note.textContent = `随窗口调整，当前 ${actualSize().toFixed(1)} px。`),
    );
}
function readingElements() {
  if (current?.type === "epub") {
    const doc = $("epub-frame").contentDocument;
    return doc?.body
      ? [
          ...doc.body.querySelectorAll("p,h1,h2,h3,h4,blockquote,figure,table"),
        ].filter(
          (element) =>
            !element.closest("nav") &&
            element.getBoundingClientRect().height > 0,
        )
      : [];
  }
  return [...$("chapter-body").children];
}
function globalRect(element) {
  const rectangle = element.getBoundingClientRect();
  if (element.ownerDocument === document) return rectangle;
  const frame = $("epub-frame").getBoundingClientRect();
  return {
    top: rectangle.top + frame.top,
    bottom: rectangle.bottom + frame.top,
    left: rectangle.left + frame.left,
    right: rectangle.right + frame.left,
    width: rectangle.width,
    height: rectangle.height,
  };
}
function captureAnchor() {
  if (!current || current.type === "pdf" || !readerReady) return null;
  const elements = readingElements(),
    view = $("reading-viewport").getBoundingClientRect();
  const frame =
    current.type === "epub"
      ? $("epub-frame").getBoundingClientRect()
      : { top: 0, left: 0 };
  const doc = current.type === "epub" ? frameDocument() : document;
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index],
      walker = doc.createTreeWalker(element, 4);
    let offset = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const range = doc.createRange();
      range.selectNodeContents(node);
      for (const [lineIndex, rect] of [...range.getClientRects()].entries()) {
        const top = rect.top + frame.top,
          left = rect.left + frame.left;
        if (
          rect.height < 1 ||
          rect.width < 1 ||
          top < view.top + 3 ||
          top >= view.bottom - 3 ||
          left < view.left ||
          left >= view.right
        )
          continue;
        // Range geometry also works underneath open settings and import dialogs.
        const prefix = doc.createRange();
        prefix.setStart(node, 0);
        let lo = 0,
          hi = node.length;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          prefix.setEnd(node, mid);
          if (prefix.getClientRects().length > lineIndex) hi = mid;
          else lo = mid + 1;
        }
        const char = Math.max(0, lo - 1);
        return {
          index,
          quote: element.textContent.trim().slice(0, 60),
          charOffset: offset + char,
          pixels: top - view.top,
        };
      }
      offset += node.length;
    }
    const rect = globalRect(element);
    if (
      !element.textContent.trim() &&
      rect.bottom > view.top &&
      rect.top < view.bottom &&
      rect.left < view.right &&
      rect.right > view.left
    )
      return { index, quote: "", charOffset: 0, pixels: rect.top - view.top };
  }
  return null;
}

function restoreAnchor(anchor) {
  if (!anchor || !readerReady) return;
  const elements = readingElements();
  let element = elements[anchor.index];
  if (
    anchor.quote &&
    (!element || !element.textContent.trim().startsWith(anchor.quote))
  )
    element =
      elements.find((element) =>
        element.textContent.trim().startsWith(anchor.quote),
      ) || element;
  if (!element) return;
  anchor.index = elements.indexOf(element);
  retainedAnchor = anchor;
  if (pagination) {
    pagination.reveal(element, anchor.charOffset || 0);
    return;
  }
  let rect = globalRect(element),
    remaining = anchor.charOffset || 0;
  if (remaining) {
    const doc = element.ownerDocument,
      walker = doc.createTreeWalker(element, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (remaining <= node.length) {
        const range = doc.createRange();
        range.setStart(node, remaining);
        range.setEnd(node, Math.min(node.length, remaining + 1));
        const line = range.getClientRects()[0];
        if (line) {
          const shift =
            doc === document ? 0 : $("epub-frame").getBoundingClientRect().top;
          rect = { ...rect, top: line.top + shift };
        }
        break;
      }
      remaining -= node.length;
    }
  }
  const top = $("reading-viewport").getBoundingClientRect().top;
  $("reading-viewport").scrollTop +=
    rect.top -
    top -
    (anchor.inside
      ? anchor.offset * rect.height
      : Math.max(0, anchor.pixels || 0));
}

async function changePreference(key, value) {
  const epoch = ++preferenceRevision,
    revision = renderRevision;
  pendingAnchor ??= lastAnchor || captureAnchor();
  const anchor = pendingAnchor;
  retainedAnchor = anchor;
  prefs[key] = value;
  applyPreferences();
  postState({ prefs: { [key]: value } }).catch((error) => toast(error.message));
  if (key === "pdfZoom" || key === "pdfMode") {
    if (current?.type === "pdf" && route === "reader")
      renderCurrent(makePosition());
    renderSettings();
    return;
  }
  if (current?.type === "epub" && readerReady) await styleEpub();
  await Promise.all(
    [prefs.zhFont, prefs.enFont].map((key) =>
      document.fonts.load(`20px ${fontFamilies[key]}`).catch(() => {}),
    ),
  );
  if (epoch !== preferenceRevision || revision !== renderRevision) return;
  if (route === "reader" && current?.type !== "pdf") configureTextLayout();
  restorePosition(() => restoreAnchor(anchor));
  pendingAnchor = null;
  lastAnchor = retainedAnchor || captureAnchor();
  updateProgress();
  reportNative();
  if (key.endsWith("Mode")) renderSettings();
  document
    .querySelectorAll("[data-theme]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.theme === prefs.theme),
      ),
    );
  document
    .querySelectorAll(`[data-output="${key}"]`)
    .forEach(
      (output) =>
        (output.textContent =
          key === "fontSize"
            ? `${value} px`
            : key === "textWidth"
              ? `${value} px`
              : key === "lineHeight"
                ? Number(value).toFixed(2)
                : `${Math.round(value * (key === "palmScale" ? 100 : 1))}%`),
    );
}

function reportNative() {
  if (native && readerReady)
    window.webkit.messageHandlers.readerNative.postMessage({
      action: "reader-state",
      reader: {
        build: "2.12",
        book: current.id,
        index: location.index,
        fontSize: actualSize(),
        anchor: retainedAnchor || captureAnchor(),
        top: $("reading-viewport").scrollTop,
        mode: readingMode(),
        page: pagination?.page + 1,
        pages: pagination?.count,
      },
    });
}
function snapshot() {
  return { book: current.id, position: makePosition() };
}
function makePosition() {
  if (!current || !location) return {};
  const anchor = retainedAnchor || captureAnchor();
  let sourceOffset = location.sourceOffset;
  if (current.type === "txt" && anchor) {
    const element = $("chapter-body").children[anchor.index];
    sourceOffset =
      Number(element?.dataset.sourceOffset || 0) + (anchor.charOffset || 0);
  }
  return {
    ...location,
    top:
      current.type === "pdf" ? pdfLocalTop() : $("reading-viewport").scrollTop,
    page: pagination?.page || 0,
    anchor: anchor ? { ...anchor } : null,
    sourceOffset,
    progress: currentProgress(),
    updatedAt: Date.now(),
  };
}
function savePosition(force = false) {
  if (
    !current ||
    !readerReady ||
    route !== "reader" ||
    (restoringPosition && !force)
  )
    return stateQueue;
  const position = makePosition();
  location = { ...position };
  positions[current.id] = position;
  reportNative();
  return postState({
    positions: { [current.id]: position },
    lastBook: current.id,
  });
}
window.readerFlush = () => savePosition(true);
function currentProgress() {
  if (!current || !location) return 0;
  const view = $("reading-viewport"),
    fraction = pagination
      ? pagination.page / Math.max(1, pagination.count - 1)
      : view.scrollHeight <= view.clientHeight + 1
        ? 0
        : view.scrollTop / (view.scrollHeight - view.clientHeight);
  return current.type === "pdf"
    ? (location.index -
        1 +
        Math.max(0, pdfLocalTop()) /
          Math.max(1, pdfPageElement(location.index)?.offsetHeight || 1)) /
        current.pages
    : chapterProgress(current.chapters, location.index - 1, fraction);
}

function updateProgress() {
  if (!current || !location) return;
  const progress = currentProgress();
  $("progress-fill").style.width = `${progress * 100}%`;
  $("page-label").textContent = pagination
    ? `${pagination.page + 1} / ${pagination.count} 页`
    : `${location.index} / ${count(current)}`;
  $("page-label").dataset.chapter = location.index;
  $("palm-position").textContent = pagination
    ? `${pagination.page + 1} / ${pagination.count} · ${Math.round(progress * 100)}%`
    : `${chapterTitle()} · ${Math.round(progress * 100)}%`;
  $("position-label").textContent =
    current.type === "pdf"
      ? `${current.pageOffset !== null && location.index > current.pageOffset ? "书页 " + (location.index - current.pageOffset) : "PDF 第 " + location.index + " 页"} · ${chapterTitle()}`
      : chapterTitle();
  const view = $("reading-viewport"),
    first = pagination ? pagination.page === 0 : view.scrollTop < 1,
    last = pagination
      ? pagination.page === pagination.count - 1
      : view.scrollTop + view.clientHeight >= view.scrollHeight - 2;
  $("previous-button").disabled = $("palm-previous").disabled =
    flipBusy || (location.index === 1 && first);
  $("next-button").disabled = $("palm-next").disabled =
    flipBusy || (location.index === count(current) && last);
  const mode = readingMode();
  $("reading-mode").innerHTML = icon(mode === "pages" ? "pages" : "scroll");
  $("reading-mode").setAttribute(
    "aria-label",
    mode === "pages" ? "当前翻页阅读，切换为滚动" : "当前连续滚动，切换为翻页",
  );
  $("reading-mode").title = mode === "pages" ? "翻页阅读" : "连续滚动";
  if (readerReady) {
    const here = {
      ...location,
      top: current.type === "pdf" ? pdfLocalTop() : view.scrollTop,
      anchor: retainedAnchor || captureAnchor(),
    };
    $("bookmark-button").setAttribute(
      "aria-pressed",
      String(
        bookmarks.some(
          (mark) => mark.book === current.id && samePlace(mark.position, here),
        ),
      ),
    );
  }
}

function renderToc() {
  if (!current) return;
  const text = $("toc-search").value.trim().toLocaleLowerCase();
  const active = flatToc(current.toc || [])
    .filter((item) => item.index && item.index <= location.index)
    .sort((a, b) => a.index - b.index)
    .at(-1);
  function node(item, inherited = false) {
    const matches = inherited || item.title.toLocaleLowerCase().includes(text);
    const children = (item.children || [])
      .map((child) => node(child, matches))
      .join("");
    if (text && !matches && !children) return "";
    const currentItem = active === item;
    const row = `<button class="toc-item${currentItem ? " active" : ""}" data-index="${item.index || ""}" data-fragment="${escapeHTML(item.fragment || "")}" ${!item.index ? "disabled" : ""} ${currentItem ? 'aria-current="true"' : ""}><span>${escapeHTML(item.title)}</span>${item.printed ? `<small>${escapeHTML(item.printed)}</small>` : ""}</button>`;
    if (!item.children?.length) return row;
    const open = !!text || flatToc([item]).includes(active);
    return `<details ${open ? "open" : ""}><summary><span>${escapeHTML(item.title)}</span>${item.printed ? `<small>${item.printed}</small>` : ""}</summary>${item.index ? `<button class="toc-item" data-index="${item.index}" data-fragment="${escapeHTML(item.fragment || "")}"><span>${current.type === "pdf" ? "本章起始页" : "从这里阅读"}</span></button>` : ""}${children}</details>`;
  }
  $("toc-list").innerHTML =
    (current.toc || []).map((item) => node(item)).join("") ||
    `<div class="empty-state">${current.processing === "pending" ? "正在建立原书目录，可先按页阅读。" : text ? "没有找到这个章节。" : "暂无可用目录。"}</div>`;
  const sourceLabels = {
    "epub-nav": "原书 EPUB 目录",
    "epub-ncx": "原书 EPUB 目录",
    spine: "原书阅读顺序",
    "pdf-outline": "PDF 原有书签",
    "ocr-contents": "从扫描目录识别",
    "txt-rules": "从章节标题识别",
    text: "纯文本阅读",
    "html-headings": "文档原有标题",
    "image-order": "图像页序",
  };
  $("toc-source").textContent =
    (sourceLabels[current.tocSource] || "目录准备中") +
    (current.type === "pdf" && current.pageOffset !== null
      ? ` · 书页 + ${current.pageOffset} = PDF 页序`
      : "") +
    (current.tocSource === "ocr-contents" && current.pageOffset === null
      ? " · 请在书籍设置中校正页码"
      : "");
  renderBookmarks();
}
function samePlace(a, b) {
  if (a.index !== b.index) return false;
  if (current.type === "pdf" || !a.anchor || !b.anchor)
    return Math.abs((a.top || 0) - (b.top || 0)) < 80;
  return (
    a.anchor.index === b.anchor.index &&
    Math.abs((a.anchor.charOffset || 0) - (b.anchor.charOffset || 0)) < 20
  );
}
function renderBookmarks() {
  if (!current) return;
  const marks = bookmarks.filter((mark) => mark.book === current.id);
  $("bookmarks-list").innerHTML =
    marks
      .map(
        (mark) =>
          `<div class="bookmark-row"><button class="bookmark-open" data-mark="${mark.id}">${escapeHTML(mark.label)}<small>${escapeHTML(mark.detail)}</small></button><button class="icon-button" data-remove-mark="${mark.id}" aria-label="删除书签">${icon("close")}</button></div>`,
      )
      .join("") || '<div class="empty-state">给想再读的地方，留个记号。</div>';
  const position = makePosition();
  $("bookmark-button").setAttribute(
    "aria-pressed",
    String(marks.some((mark) => samePlace(mark.position, position))),
  );
}
async function toggleBookmark() {
  if (!readerReady) return;
  const position = makePosition();
  const mark = bookmarks.find(
    (mark) => mark.book === current.id && samePlace(mark.position, position),
  );
  if (mark) {
    bookmarks = bookmarks.filter((item) => item !== mark);
    await postState({ bookmarkChanges: { remove: [mark.id] } });
    toast("书签已移除。");
  } else {
    const added = {
      id: crypto.randomUUID(),
      book: current.id,
      position,
      label: chapterTitle(),
      detail:
        current.type === "pdf"
          ? `PDF 第 ${location.index} 页`
          : pagination
            ? `本章第 ${pagination.page + 1} 页 · ${Math.round(position.progress * 100)}%`
            : `${Math.round(position.progress * 100)}%`,
    };
    bookmarks.push(added);
    await postState({ bookmarkChanges: { add: [added] } });
    toast("已为这里留下书签。");
  }
  renderBookmarks();
}

function clearSelection() {
  currentSelection = null;
  $("selection-toolbar").hidden = true;
  window.getSelection()?.removeAllRanges();
  try {
    $("epub-frame").contentWindow?.getSelection()?.removeAllRanges();
  } catch {}
  document
    .querySelectorAll(".pdf-object.selected")
    .forEach((element) => element.classList.remove("selected"));
  const doc = $("epub-frame").contentDocument;
  doc
    ?.querySelectorAll("[data-reader-selected]")
    .forEach((element) => element.removeAttribute("data-reader-selected"));
}
function selectionContext() {
  return `《${current.title}》 · ${current.type === "pdf" ? "PDF 第 " + location.index + " 页" : chapterTitle()}`;
}
function showToolbar(rectangle) {
  const bar = $("selection-toolbar");
  bar.hidden = false;
  $("copy-selection").hidden = currentSelection.kind === "image";
  $("copy-image").hidden = !currentSelection.image;
  $("copy-label").textContent =
    currentSelection.format === "latex"
      ? "复制 LaTeX"
      : currentSelection.format === "mathml"
        ? "复制 MathML"
        : currentSelection.kind === "table"
          ? "复制表格"
          : "复制";
  bar.style.left = `${Math.max(7, Math.min(innerWidth - bar.offsetWidth - 7, rectangle.left + rectangle.width / 2 - bar.offsetWidth / 2))}px`;
  bar.style.top = `${Math.max(7, Math.min(innerHeight - bar.offsetHeight - 38, rectangle.bottom + 8))}px`;
}
function captureSelection(doc = document) {
  const selection = doc.defaultView.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const root =
    current?.type === "epub"
      ? $("epub-frame").contentDocument?.body
      : current?.type === "pdf"
        ? $("pdf-paper")
        : $("chapter-body");
  if (!root?.contains(range.commonAncestorContainer)) return;
  const text = selection.toString().trim();
  if (!text) return;
  const pdfPage =
    range.startContainer.parentElement?.closest(".pdf-page")?.dataset.page;
  currentSelection = {
    text,
    kind: "text",
    source: pdfPage
      ? `《${current.title}》 · PDF 第 ${pdfPage} 页`
      : selectionContext(),
  };
  const rects = [...range.getClientRects()].filter(
    (rect) => rect.width && rect.height,
  );
  if (!rects.length) return;
  const rectangle = rects.at(-1);
  if (doc !== document) {
    const frame = $("epub-frame").getBoundingClientRect();
    showToolbar({
      left: rectangle.left + frame.left,
      top: rectangle.top + frame.top,
      bottom: rectangle.bottom + frame.top,
      width: rectangle.width,
      height: rectangle.height,
    });
  } else showToolbar(rectangle);
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制。");
  } catch {
    toast("请选中文字后按 ⌘C 复制。");
  }
}
async function copyImage() {
  if (!currentSelection?.image) return;
  try {
    const image = new Image();
    image.src = currentSelection.image;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d").drawImage(image, 0, 0);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("原图已复制。");
  } catch {
    toast("图片暂时无法复制，可在原书中查看完整图像。");
  }
}

function renderObjects(blocks, viewport, root, page) {
  root.replaceChildren();
  for (const block of blocks.filter((block) =>
    ["equation", "image", "table"].includes(block.type),
  )) {
    const [x0, y0, x1, y1] = block.bbox,
      button = document.createElement("button");
    button.className = "pdf-object";
    button.setAttribute(
      "aria-label",
      block.type === "equation" ? "选择完整公式" : "选择完整图表",
    );
    Object.assign(button.style, {
      left: `${x0 * viewport.width}px`,
      top: `${y0 * viewport.height}px`,
      width: `${(x1 - x0) * viewport.width}px`,
      height: `${(y1 - y0) * viewport.height}px`,
    });
    button.onclick = () => {
      clearSelection();
      button.classList.add("selected");
      currentSelection = {
        kind: block.type,
        text: block.text || "[完整图表]",
        image: block.image,
        format: block.type === "equation" ? "latex" : null,
        source: `《${current.title}》 · PDF 第 ${page} 页`,
      };
      showToolbar(button.getBoundingClientRect());
    };
    root.append(button);
  }
}
function renderOCR(data, viewport, root) {
  root.replaceChildren();
  root.lang = current.language;
  const measure = document.createElement("canvas").getContext("2d");
  for (const line of data.lines) {
    const words = line.segments?.length
      ? line.segments
      : [{ text: line.text, bbox: line.bbox }];
    for (const word of words) {
      const [x0, y0, x1, y1] = word.bbox;
      if (x1 <= x0 || y1 <= y0) continue;
      const span = document.createElement("span"),
        height = (y1 - y0) * viewport.height;
      span.textContent = word.text;
      const family = current.language?.startsWith("zh")
        ? "Songti SC, serif"
        : "Times New Roman, serif";
      measure.font = `${height}px ${family}`;
      Object.assign(span.style, {
        left: `${x0 * viewport.width}px`,
        top: `${y0 * viewport.height}px`,
        fontSize: `${height}px`,
        height: `${height}px`,
        fontFamily: family,
        transform: `scaleX(${((x1 - x0) * viewport.width) / Math.max(1, measure.measureText(word.text.trimEnd()).width)})`,
      });
      root.append(span);
    }
    root.append(document.createElement("br"));
  }
}
async function prepareOcr(book, page, viewport, revision, root) {
  if (!book.parseEnabled) {
    if (page === location.index) {
      $("ocr-status").hidden = false;
      $("ocr-status").innerHTML =
        '扫描页没有文字层。<button id="enable-page-ocr">开启文档解析</button>';
      $("enable-page-ocr").onclick = async () => {
        const response = await post("/api/books/" + book.id, {
          parseEnabled: true,
        });
        Object.assign(current, response.book);
        renderCurrent(makePosition());
      };
    }
    return;
  }
  const key = book.id + ":" + page;
  if (page === location.index) {
    $("ocr-status").textContent = "正在准备本页可选文字…";
    $("ocr-status").hidden = false;
  }
  try {
    if (!ocrCache.has(key))
      ocrCache.set(
        key,
        api(`/api/ocr?book=${book.id}&page=${page}`).catch((error) => {
          ocrCache.delete(key);
          throw error;
        }),
      );
    const data = await ocrCache.get(key);
    if (
      revision !== renderRevision ||
      !current.parseEnabled ||
      !root.isConnected
    )
      return;
    renderOCR(data, viewport, root.querySelector(".textLayer"));
    if (data.blocks)
      renderObjects(
        data.blocks,
        viewport,
        root.querySelector(".object-layer"),
        page,
      );
    root.dataset.ocr = "ready";
    if (page === location.index) {
      $("ocr-status").textContent = data.lines.length
        ? "文字已就绪，可直接划词。"
        : "本页没有识别到文字。";
      clearTimeout(ocrTimer);
      ocrTimer = setTimeout(() => {
        if (revision === renderRevision) $("ocr-status").hidden = true;
      }, 1800);
    }
  } catch (error) {
    root.dataset.ocr = "error";
    if (revision === renderRevision && page === location.index) {
      $("ocr-status").textContent = error.message;
      $("ocr-status").hidden = false;
    }
  }
}
let pdfDocument,
  pdfRevision = 0,
  pdfWidth = 0,
  pdfRenderQueue = Promise.resolve();
const pdfTasks = new Map();
function pdfPageElement(index) {
  return $("pdf-paper").querySelector(`[data-page="${index}"]`);
}
function pdfPageTop(index) {
  const element = pdfPageElement(index),
    view = $("reading-viewport");
  return element
    ? element.getBoundingClientRect().top -
        view.getBoundingClientRect().top +
        view.scrollTop
    : 0;
}
function pdfLocalTop() {
  return $("reading-viewport").scrollTop - pdfPageTop(location?.index || 1);
}
function scrollPdfTo(position) {
  $("reading-viewport").scrollTop =
    pdfPageTop(position.index) +
    Math.min(
      position.top || 0,
      Math.max(0, (pdfPageElement(position.index)?.offsetHeight || 1) - 20),
    );
}
async function paintPdfPage(index, revision) {
  const root = pdfPageElement(index);
  if (!root || root.dataset.rendered || revision !== renderRevision) return;
  root.dataset.rendered = "loading";
  root.removeAttribute("aria-hidden");
  const page = await pdfDocument.getPage(index);
  if (revision !== renderRevision || !root.isConnected) return;
  const viewport = page.getViewport({
      scale: pdfWidth / page.getViewport({ scale: 1 }).width,
    }),
    density = Math.min(devicePixelRatio || 1, 2);
  root.style.height = `${viewport.height}px`;
  root.replaceChildren();
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", `PDF 第 ${index} 页`);
  canvas.width = Math.round(viewport.width * density);
  canvas.height = Math.round(viewport.height * density);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  const text = document.createElement("div");
  text.className = "textLayer";
  const objects = document.createElement("div");
  objects.className = "object-layer";
  root.append(canvas, text, objects);
  const task = page.render({
    canvasContext: canvas.getContext("2d"),
    viewport,
    transform: density === 1 ? null : [density, 0, 0, density, 0, 0],
  });
  pdfTasks.set(index, task);
  await task.promise;
  pdfTasks.delete(index);
  if (revision !== renderRevision) return;
  const content = await page.getTextContent();
  if (revision !== renderRevision) return;
  if (content.items.some((item) => item.str?.trim())) {
    text.style.setProperty("--scale-factor", viewport.scale);
    const layer = new pdfjs.TextLayer({
      textContentSource: content,
      container: text,
      viewport,
    });
    await layer.render();
    root.dataset.ocr = "native";
  }
  root.dataset.rendered = "ready";
  root._viewport = viewport;
  if (index === location.index && !root.dataset.ocr)
    prepareOcr(current, index, viewport, revision, root);
}
function ensurePdfPages() {
  if (!pdfDocument || pdfRevision !== renderRevision) return;
  const revision = renderRevision,
    index = location.index;
  for (const page of [index, index + 1, index - 1])
    if (page >= 1 && page <= current.pages) {
      const root = pdfPageElement(page);
      if (!root?.dataset.rendered)
        pdfRenderQueue = pdfRenderQueue
          .catch(() => {})
          .then(() => paintPdfPage(page, revision))
          .catch((error) => {
            if (
              error.name !== "RenderingCancelledException" &&
              revision === renderRevision
            )
              toast("PDF 页面暂时无法显示：" + error.message);
          });
    }
  const active = pdfPageElement(index);
  if (
    active?.dataset.rendered === "ready" &&
    !active.dataset.ocr &&
    active._viewport
  ) {
    active.dataset.ocr = "loading";
    prepareOcr(current, index, active._viewport, revision, active);
  }
  for (const element of $("pdf-paper").children) {
    if (
      Math.abs(Number(element.dataset.page) - index) > 3 &&
      element.dataset.rendered === "ready"
    ) {
      element.querySelectorAll("canvas").forEach((canvas) => {
        canvas.width = 0;
        canvas.height = 0;
      });
      element.replaceChildren();
      delete element.dataset.rendered;
      delete element.dataset.ocr;
      element.setAttribute("aria-hidden", "true");
    }
  }
}
function updatePdfScroll() {
  if (!pdfDocument || prefs.pdfMode !== "scroll") return;
  const view = $("reading-viewport"),
    at = view.scrollTop + Math.min(160, view.clientHeight * 0.25);
  let lo = 1,
    hi = current.pages;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (pdfPageTop(mid) <= at) lo = mid;
    else hi = mid - 1;
  }
  if (lo !== location.index) {
    location.index = lo;
    renderToc();
    $("ocr-status").hidden = true;
  }
  ensurePdfPages();
}
async function renderPdf(position, revision) {
  const book = current;
  pdfTasks.forEach((task) => task.cancel());
  pdfTasks.clear();
  pdfRenderQueue = Promise.resolve();
  pdfDocument = null;
  if (!pdfs.has(book.id))
    pdfs.set(
      book.id,
      pdfjs
        .getDocument({
          url: book.url,
          standardFontDataUrl: new URL(
            "/assets/vendor/standard_fonts/",
            window.location,
          ).href,
          cMapUrl: new URL("/assets/vendor/cmaps/", window.location).href,
          cMapPacked: true,
          wasmUrl: new URL("/assets/vendor/wasm/", window.location).href,
          isEvalSupported: false,
        })
        .promise.catch((error) => {
          pdfs.delete(book.id);
          throw error;
        }),
    );
  const pdf = await pdfs.get(book.id);
  if (revision !== renderRevision) return;
  const page = await pdf.getPage(position.index);
  if (revision !== renderRevision) return;
  pdfDocument = pdf;
  pdfRevision = revision;
  pdfWidth =
    (Math.min(
      960,
      $("reading-viewport").clientWidth - (innerWidth < 760 ? 26 : 80),
    ) *
      prefs.pdfZoom) /
    100;
  const viewport = page.getViewport({
      scale: pdfWidth / page.getViewport({ scale: 1 }).width,
    }),
    stack = $("pdf-paper");
  stack.replaceChildren();
  stack.style.width = `${pdfWidth}px`;
  stack.style.height = "auto";
  stack.dataset.book = book.id;
  stack.classList.toggle("continuous", prefs.pdfMode === "scroll");
  const indices =
    prefs.pdfMode === "scroll"
      ? Array.from({ length: book.pages }, (_, index) => index + 1)
      : [position.index];
  for (const index of indices) {
    const root = document.createElement("div");
    root.className = "pdf-page";
    root.setAttribute("aria-hidden", "true");
    root.dataset.page = index;
    root.style.height = `${viewport.height}px`;
    root.style.width = `${pdfWidth}px`;
    stack.append(root);
  }
  restorePosition(() => scrollPdfTo(position));
  await paintPdfPage(position.index, revision);
  if (revision !== renderRevision) return;
  $("reader-loading").hidden = true;
  readerReady = true;
  restorePosition(() => scrollPdfTo(position));
  ensurePdfPages();
  updateProgress();
}

function bookResourceRoot() {
  return (
    new URL(current.chapters[0].url, window.location).pathname.split(
      "/content/",
    )[0] + "/content/"
  );
}
function readingMode() {
  return current?.type === "pdf"
    ? prefs.pdfMode
    : palm
      ? prefs.palmMode
      : prefs.textMode;
}
function configureTextLayout() {
  pagination?.destroy();
  pagination = null;
  const view = $("reading-viewport"),
    paged = readingMode() === "pages";
  view.classList.toggle("paged", paged);
  view.scrollTop = 0;
  const host = current.type === "epub" ? frameDocument()?.body : $("text-host");
  const flow =
    current.type === "epub"
      ? frameDocument()?.getElementById("reader-flow")
      : $("text-paper");
  if (!host || !flow) return;
  const width =
    current.type === "epub" ? $("epub-frame").clientWidth : host.clientWidth;
  const padding = palm ? [18, 10] : innerWidth < 760 ? [30, 25] : [40, 50];
  if (paged) {
    const height =
      view.clientHeight -
      parseFloat(getComputedStyle(view).paddingTop) -
      parseFloat(getComputedStyle(view).paddingBottom);
    if (current.type === "epub")
      $("epub-frame").style.height = `${Math.floor(height)}px`;
    host.style.position = "relative";
    pagination = new PageLayout(host, flow, width, height, padding);
  } else if (current.type === "epub") {
    flow.removeAttribute("style");
    measureEpub();
  }
}
function revealPosition(position) {
  if (position.fragment) {
    const doc = current.type === "epub" ? frameDocument() : document,
      target =
        doc.getElementById(position.fragment) ||
        doc.querySelector(`[name="${CSS.escape(position.fragment)}"]`);
    if (target) {
      if (pagination) pagination.reveal(target);
      else
        $("reading-viewport").scrollTop +=
          globalRect(target).top -
          $("reading-viewport").getBoundingClientRect().top;
      return;
    }
  }
  if (pagination) {
    pagination.set(position.end ? pagination.count - 1 : position.page || 0);
    restoreAnchor(position.anchor);
  } else {
    $("reading-viewport").scrollTop = position.end
      ? Number.MAX_SAFE_INTEGER
      : position.top || 0;
    restoreAnchor(position.anchor);
  }
}
function onPageInput(event) {
  if (
    readingMode() !== "pages" ||
    !readerReady ||
    event.ctrlKey ||
    event.metaKey ||
    event.target.closest?.("input,textarea,select,table")
  )
    return;
  if (event.type === "wheel") {
    if (Math.abs(event.deltaY) + Math.abs(event.deltaX) < 8) return;
    event.preventDefault();
    const now = Date.now();
    if (now - lastWheel < 420) return;
    lastWheel = now;
    flip(
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? Math.sign(event.deltaX)
        : Math.sign(event.deltaY),
    );
  }
}
let lastWheel = 0,
  touchStart;
function attachPageGestures(target) {
  target.addEventListener("wheel", onPageInput, { passive: false });
  target.addEventListener(
    "touchstart",
    (event) => {
      touchStart =
        event.touches.length === 1
          ? [event.touches[0].clientX, event.touches[0].clientY]
          : null;
    },
    { passive: true },
  );
  target.addEventListener(
    "touchend",
    (event) => {
      if (
        !touchStart ||
        readingMode() !== "pages" ||
        !event.changedTouches[0] ||
        (!target.getSelection?.()?.isCollapsed && target.getSelection?.())
      )
        return;
      const dx = event.changedTouches[0].clientX - touchStart[0],
        dy = event.changedTouches[0].clientY - touchStart[1];
      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4)
        flip(dx < 0 ? 1 : -1);
      touchStart = null;
    },
    { passive: true },
  );
}
function frameDocument() {
  return $("epub-frame").contentDocument;
}
function measureEpub() {
  if (current?.type !== "epub" || readingMode() === "pages") return;
  const doc = frameDocument();
  if (!doc?.body) return;
  const height = Math.ceil(doc.body.getBoundingClientRect().height + 4);
  if (height > 0 && Math.abs($("epub-frame").offsetHeight - height) > 2)
    $("epub-frame").style.height = `${height}px`;
}

async function styleEpub() {
  const doc = frameDocument();
  if (!doc?.body) return;
  let style = doc.getElementById("page-between-style");
  if (!style) {
    style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
    style.id = "page-between-style";
    doc.head.append(style);
  }
  const colors = getComputedStyle(document.body),
    padding = palm
      ? "18px 10px 24px"
      : innerWidth < 760
        ? "30px 25px"
        : "46px 50px";
  const fixed = current.layout === "pre-paginated";
  style.textContent = `.reader-flow{font:inherit;color:inherit;}.reader-flow :is(img,svg,table,figure){break-inside:avoid;}.reader-flow :is(h1,h2,h3,h4){break-after:avoid;}html{height:auto!important;min-height:0!important;margin:0!important;padding:0!important;overflow:hidden!important;background:${colors.getPropertyValue("--paper")}!important;color:${colors.getPropertyValue("--ink")}!important;font-size:${actualSize()}px!important;}body{height:auto!important;min-height:0!important;margin:0!important;padding:${padding}!important;box-sizing:border-box!important;font-family:${fontFamilies[prefs.enFont]},${fontFamilies[prefs.zhFont]},serif!important;font-size:${actualSize()}px!important;line-height:${palm ? 1.65 : prefs.lineHeight}!important;overflow-wrap:break-word!important;color:${colors.getPropertyValue("--ink")}!important;background:${colors.getPropertyValue("--paper")}!important;}img{max-width:100%!important;}svg[viewBox][height="100%"]{height:auto!important;max-width:100%!important;}p{font-family:inherit!important;line-height:${palm ? 1.65 : prefs.lineHeight}!important;}table{max-width:100%;}a{color:${colors.getPropertyValue("--accent")};} [data-reader-selected]{outline:2px solid ${colors.getPropertyValue("--accent")};outline-offset:3px;}::selection{background:#8cb49b60;}${prefs.theme === "night" ? "body :is(p,span,div,h1,h2,h3,h4,li,blockquote){color:inherit!important;background-color:transparent!important;}" : ""}${palm ? "h1{font-size:1.25em!important;}h2{font-size:1.15em!important;}h3{font-size:1.08em!important;}" : ""}${fixed ? "body{padding:0!important;}" : ""}${readingMode() === "pages" ? `html,body{width:100%!important;height:100%!important;padding:0!important;}#reader-flow{font:inherit;}.reader-flow :is(img,svg){max-height:${Math.max(80, $("reading-viewport").clientHeight - (palm ? 90 : 160))}px!important;object-fit:contain;}` : ""}`;
  await Promise.race([
    Promise.all(
      [prefs.zhFont, prefs.enFont].map((key) =>
        doc.fonts.load(`20px ${fontFamilies[key]}`).catch(() => {}),
      ),
    ),
    new Promise((resolve) => setTimeout(resolve, 1800)),
  ]);
}
async function renderEpub(position, revision) {
  const frame = $("epub-frame");
  let chapter = current.chapters[position.index - 1];
  if (position.resource) {
    const url = new URL(position.resource, window.location);
    if (
      url.origin === window.location.origin &&
      url.pathname.startsWith(bookResourceRoot()) &&
      /\.x?html?$/i.test(url.pathname)
    )
      chapter = { ...chapter, url: url.pathname };
    else delete position.resource;
  }
  if (frame.dataset.chapter !== chapter.url || !frame.contentDocument?.body) {
    frame.style.height = "1px";
    const response = await fetch(chapter.url);
    if (!response.ok) throw new Error("章节文件无法读取。");
    const source = await response.text();
    if (revision !== renderRevision) return;
    const parsed = new DOMParser().parseFromString(source, "text/html");
    const base = parsed.createElement("base");
    base.href = new URL(chapter.url, window.location).href;
    const policy = parsed.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    policy.content =
      "default-src 'self' data: blob:;script-src 'none';connect-src 'none';object-src 'none';frame-src 'none';style-src 'self' 'unsafe-inline';font-src 'self' data:;img-src 'self' data: blob:;form-action 'none';base-uri 'self'";
    parsed
      .querySelectorAll(
        'meta[http-equiv="Content-Security-Policy" i],meta[http-equiv="refresh" i]',
      )
      .forEach((element) => element.remove());
    policy.content = policy.content.replaceAll(
      "'self'",
      window.location.origin,
    );
    const fontLink = parsed.createElement("link");
    fontLink.rel = "stylesheet";
    fontLink.href = new URL("/epub-reader.css", window.location).href;
    parsed.head.prepend(policy, base);
    parsed.head.append(fontLink);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("原书章节载入超时，请重试。")),
        25000,
      );
      frame.onload = () => {
        clearTimeout(timeout);
        resolve();
      };
      frame.srcdoc = "<!doctype html>" + parsed.documentElement.outerHTML;
    });
    if (revision !== renderRevision) return;
    frame.dataset.chapter = chapter.url;
    const doc = frameDocument();
    if (revision !== renderRevision) return;
    doc.documentElement.lang = current.language || "zh";
    const flow = doc.createElement("div");
    flow.id = "reader-flow";
    flow.append(...doc.body.childNodes);
    doc.body.append(flow);
    attachPageGestures(doc);
    doc.addEventListener("mouseup", () =>
      setTimeout(() => captureSelection(doc), 10),
    );
    doc.addEventListener("mousedown", () => {
      $("selection-toolbar").hidden = true;
      currentSelection = null;
    });
    doc.addEventListener("keydown", handleKeydown);
    doc.addEventListener("copy", onCopy);
    doc.addEventListener("click", onEpubClick);
  }
  await styleEpub();
  if (revision !== renderRevision) return;
  const doc = frameDocument();
  await Promise.all(
    [...doc.images].map((image) =>
      image.complete
        ? Promise.resolve()
        : new Promise((resolve) => {
            image.addEventListener("load", resolve, { once: true });
            image.addEventListener("error", resolve, { once: true });
          }),
    ),
  );
  if (revision !== renderRevision) return;
  configureTextLayout();
  epubObserver?.disconnect();
  if (readingMode() === "scroll") {
    epubObserver = new ResizeObserver(() => {
      measureEpub();
      updateProgress();
    });
    epubObserver.observe(doc.body);
  }
  $("reader-loading").hidden = true;
  readerReady = true;
  restorePosition(() => revealPosition(position));
  location.fragment = "";
  lastAnchor = retainedAnchor || captureAnchor();
  updateProgress();
}
function onEpubClick(event) {
  const anchor = event.target.closest?.("a"),
    href = anchor
      ? (anchor.getAttribute("href") ?? anchor.getAttribute("xlink:href"))
      : null;
  if (href !== null) {
    event.preventDefault();
    let target;
    try {
      target = new URL(href, frameDocument().baseURI);
    } catch {
      return;
    }
    if (target.origin !== window.location.origin) return;
    const index = current.chapters.findIndex(
      (chapter) =>
        new URL(chapter.url, window.location).pathname === target.pathname,
    );
    if (index >= 0)
      navigate(index + 1, {
        fragment: decodeURIComponent(target.hash.slice(1)),
      });
    else if (
      target.pathname.startsWith(bookResourceRoot()) &&
      /\.x?html?$/i.test(target.pathname)
    )
      navigate(location.index, {
        resource: target.pathname,
        fragment: decodeURIComponent(target.hash.slice(1)),
      });
    return;
  }
  const element = event.target.closest?.("img,svg,table,math");
  if (!element) return;
  const rect = globalRect(element);
  if (rect.width < 35 || rect.height < 28) return;
  clearSelection();
  element.setAttribute("data-reader-selected", "true");
  let image,
    text = "",
    kind = "image",
    format;
  const tag = element.localName;
  if (tag === "table") {
    kind = "table";
    text = [...element.querySelectorAll("tr")]
      .map((row) =>
        [...row.querySelectorAll("th,td")]
          .map((cell) => cell.textContent.trim())
          .join("\t"),
      )
      .join("\n");
  } else if (tag === "math") {
    kind = "equation";
    const latex = element.querySelector('annotation[encoding*="tex"]');
    text = latex?.textContent || element.outerHTML;
    format = latex ? "latex" : "mathml";
  } else if (tag === "img") image = element.src;
  else {
    const embedded = element.querySelector("image");
    image = embedded
      ? new URL(
          embedded.getAttribute("href") || embedded.getAttribute("xlink:href"),
          frameDocument().baseURI,
        ).href
      : "data:image/svg+xml;charset=utf-8," +
        encodeURIComponent(new XMLSerializer().serializeToString(element));
  }
  currentSelection = {
    kind,
    image,
    text: text || "[完整图像]",
    format,
    source: selectionContext(),
  };
  showToolbar(rect);
}
async function renderText(position, revision) {
  const book = current;
  if (!book.loaded) {
    const data = await api(book.contentUrl);
    if (revision !== renderRevision) return;
    book.chapters.forEach((chapter, index) =>
      Object.assign(chapter, data[index]),
    );
    book.loaded = true;
  }
  await Promise.all(
    [prefs.zhFont, prefs.enFont].map((key) =>
      document.fonts.load(`20px ${fontFamilies[key]}`).catch(() => {}),
    ),
  );
  if (revision !== renderRevision) return;
  const chapter = book.chapters[position.index - 1];
  $("chapter-title").textContent = chapter.title;
  $("chapter-eyebrow").textContent = chapter.volume || book.title;
  $("text-paper").lang = book.language;
  let offset = 0;
  $("chapter-body").replaceChildren(
    ...chapter.body
      .split(/\n\s*\n|\n/)
      .filter((text) => text.trim())
      .map((text, index) => {
        const p = document.createElement("p");
        p.textContent = text.trim();
        offset = chapter.body.indexOf(text, offset);
        p.dataset.sourceOffset = (chapter.sourceOffset || 0) + offset;
        p.dataset.paragraph = index;
        offset += text.length;
        return p;
      }),
  );
  if (Number.isFinite(position.sourceOffset)) {
    const paragraphs = [...$("chapter-body").children],
      index = paragraphs.findLastIndex(
        (element) =>
          Number(element.dataset.sourceOffset) <= position.sourceOffset,
      );
    if (index >= 0) {
      const element = paragraphs[index];
      position.anchor = {
        index,
        quote: element.textContent.trim().slice(0, 60),
        charOffset: clamp(
          position.sourceOffset - Number(element.dataset.sourceOffset),
          0,
          element.textContent.length,
        ),
        pixels: position.anchor?.pixels || 0,
      };
      retainedAnchor = position.anchor;
    }
  }
  $("next-chapter").hidden =
    position.index === book.chapters.length || readingMode() === "pages";
  configureTextLayout();
  $("reader-loading").hidden = true;
  readerReady = true;
  restorePosition(() => revealPosition(position));
  lastAnchor = retainedAnchor || captureAnchor();
  updateProgress();
}
async function renderCurrent(position) {
  clearTimeout(saveTimer);
  pagination?.destroy();
  pagination = null;
  const revision = ++renderRevision;
  readerReady = false;
  retainedAnchor = position.anchor || null;
  pendingAnchor = null;
  lastAnchor = null;
  clearSelection();
  $("question-panel").hidden = true;
  $("ocr-status").hidden = true;
  epubObserver?.disconnect();
  $("text-host").hidden = current.type !== "txt";
  $("text-paper").hidden = current.type !== "txt";
  $("reading-viewport").classList.toggle(
    "paged",
    current.type !== "pdf" && readingMode() === "pages",
  );
  $("epub-frame").hidden = current.type !== "epub";
  $("pdf-paper").hidden = current.type !== "pdf";
  $("reader-loading").hidden = false;
  $("reader-loading").textContent = "正在打开这一页…";
  $("book-title").textContent = current.title;
  $("book-subtitle").textContent = position.resource
    ? "原书附加内容 · 返回后继续阅读"
    : current.author;
  $("palm-book-title").textContent = current.title;
  document.title = current.title + " · 页间";
  $("palm-open").hidden =
    current.type === "pdf" ||
    ["comic", "pre-paginated"].includes(current.layout);
  $("reader-back").disabled = !history.length;
  $("previous-button").setAttribute(
    "aria-label",
    current.type === "pdf" ? "上一页" : "上一屏",
  );
  $("next-button").setAttribute(
    "aria-label",
    current.type === "pdf" ? "下一页" : "下一屏",
  );
  renderToc();
  renderSettings();
  applyPreferences();
  try {
    if (current.type === "pdf") await renderPdf(position, revision);
    else {
      pdfTasks.forEach((task) => task.cancel());
      pdfTasks.clear();
      pdfDocument = null;
      renderTask?.cancel();
      textLayerTask?.cancel();
      if (current.type === "epub") await renderEpub(position, revision);
      else await renderText(position, revision);
    }
    if (revision === renderRevision && readerReady) {
      lastAnchor = retainedAnchor || captureAnchor();
      updateProgress();
      reportNative();
      if (palm) $("reading-viewport").focus({ preventScroll: true });
    }
  } catch (error) {
    if (
      revision !== renderRevision ||
      error.name === "RenderingCancelledException"
    )
      return;
    $("reader-loading").textContent =
      error.message || "本页暂时无法打开，请重新选择章节。";
    console.error(error);
  }
}
async function navigate(index, options = {}, record = true) {
  if (!current) return;
  if (record && readerReady) history.push(snapshot());
  location = {
    ...options,
    index: clamp(index, 1, count(current)),
    top: options.top || 0,
  };
  if (
    current.type === "pdf" &&
    readerReady &&
    prefs.pdfMode === "scroll" &&
    $("pdf-paper").dataset.book === current.id
  ) {
    restorePosition(() => scrollPdfTo(location));
    ensurePdfPages();
    renderToc();
    updateProgress();
    $("reader-back").disabled = !history.length;
  } else await renderCurrent(location);
  if (innerWidth < 760) $("reader-aside").hidden = true;
}

async function flip(direction) {
  if (!readerReady || flipBusy) return;
  retainedAnchor = null;
  clearSelection();
  const view = $("reading-viewport");
  if (pagination) {
    const next = pagination.page + direction;
    if (next >= 0 && next < pagination.count) {
      pagination.set(next, true);
      lastAnchor = retainedAnchor || captureAnchor();
      updateProgress();
      reportNative();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        lastAnchor = retainedAnchor || captureAnchor();
        savePosition().catch(() => {});
      }, 400);
      return;
    }
  } else if (current.type !== "pdf") {
    if (
      direction > 0 &&
      view.scrollTop + view.clientHeight < view.scrollHeight - 4
    ) {
      view.scrollBy({ top: view.clientHeight * 0.86, behavior: "smooth" });
      return;
    }
    if (direction < 0 && view.scrollTop > 4) {
      view.scrollBy({ top: -view.clientHeight * 0.86, behavior: "smooth" });
      return;
    }
  }
  if (location.resource) {
    goBack();
    return;
  }
  if (
    location.index + direction < 1 ||
    location.index + direction > count(current)
  )
    return;
  const animated =
    readingMode() === "pages" &&
    !matchMedia("(prefers-reduced-motion:reduce)").matches;
  if (animated) {
    flipBusy = true;
    updateProgress();
    await view.animate(
      [
        { opacity: 1, transform: "translateX(0)" },
        { opacity: 0.65, transform: `translateX(${-direction * 6}px)` },
      ],
      { duration: 180, easing: "ease-in-out" },
    ).finished;
  }
  await navigate(
    location.index + direction,
    { end: direction < 0, top: direction < 0 ? Number.MAX_SAFE_INTEGER : 0 },
    false,
  );
  if (animated) {
    await view.animate(
      [
        { opacity: 0.65, transform: `translateX(${direction * 6}px)` },
        { opacity: 1, transform: "translateX(0)" },
      ],
      { duration: 300, easing: "cubic-bezier(.3,0,.15,1)" },
    ).finished;
    flipBusy = false;
    updateProgress();
  }
  saveTimer = setTimeout(() => savePosition().catch(() => {}), 230);
}

function goBack() {
  const previous = history.pop();
  if (previous) {
    current = books.find((book) => book.id === previous.book);
    location = previous.position;
    renderCurrent(location);
  }
}
async function readBook(id) {
  const book = books.find((book) => book.id === id);
  if (!book) return;
  savePosition();
  current = book;
  location = initialLocation(book);
  history = [];
  $("toc-search").value = "";
  $("reader-aside").hidden = true;
  $("reader-settings").hidden = true;
  renderCurrent(location);
}
function showRoute() {
  const requested = window.location.hash.slice(2).split("/");
  const next = palm
    ? "reader"
    : requested[0] === "read"
      ? "reader"
      : ["library", "shelf", "imports", "settings"].includes(requested[0])
        ? requested[0]
        : "library";
  if (route === "reader" && next !== "reader") {
    savePosition(true);
    readerReady = false;
  }
  route = next;
  document.body.dataset.view = next;
  $("workspace").hidden = next === "reader";
  $("reader").hidden = next !== "reader";
  for (const [id, name] of [
    ["library-view", "library"],
    ["imports-view", "imports"],
    ["settings-view", "settings"],
  ])
    $(id).hidden = name !== (next === "shelf" ? "library" : next);
  document
    .querySelectorAll("[data-nav]")
    .forEach((a) =>
      a.setAttribute("aria-current", a.dataset.nav === next ? "page" : "false"),
    );
  if (next === "reader") {
    const id = palm
      ? query.get("book") || current?.id || books[0]?.id
      : requested[1];
    readBook(id || books[0]?.id);
  } else {
    document.title =
      (next === "shelf"
        ? "书架"
        : next === "imports"
          ? "导入管理"
          : next === "settings"
            ? "阅读设置"
            : "书库") + " · 页间";
    if (next === "library" || next === "shelf") renderLibrary();
    if (next === "imports") renderJobs();
    if (next === "settings") renderSettings();
  }
}

async function openPalm(id) {
  try {
    await savePosition(true);
    await post("/api/palm", { book: id });
    toast("已打开掌上窗口。");
  } catch (error) {
    toast(error.message);
  }
}
function openImport() {
  importFiles = [];
  $("import-files").innerHTML = "";
  $("import-result").textContent = "";
  $("import-submit").disabled = true;
  $("import-count").textContent = "文件保存在本机";
  $("import-dialog").showModal();
}
function addFiles(files) {
  for (const file of files) {
    const extension = "." + file.name.split(".").at(-1).toLowerCase();
    if (!formatInfo.some((info) => info.extension === extension)) {
      toast("暂不支持 " + file.name);
      continue;
    }
    importFiles.push({
      file,
      parse: formatInfo.find((info) => info.extension === extension)
        .parseDefault,
      shelf: extension === ".pdf" ? "学习" : "小说",
    });
  }
  renderImportFiles();
}
function renderImportFiles() {
  $("import-files").innerHTML = importFiles
    .map(
      (item, index) =>
        `<div class="import-file"><div class="import-file-name"><strong>${escapeHTML(item.file.name)}</strong><small>${(item.file.size / 1024 / 1024).toFixed(1)} MB</small><select aria-label="${escapeHTML(item.file.name)}的书籍类别" data-file-shelf="${index}"><option ${item.shelf === "小说" ? "selected" : ""}>小说</option><option ${item.shelf === "学习" ? "selected" : ""}>学习</option></select></div><label class="parse-toggle"><span>文档解析<small>${item.file.name.toLowerCase().endsWith(".pdf") ? "补充扫描文字选择与原书目录" : item.file.name.toLowerCase().endsWith(".txt") ? "识别章节标题，建立导航" : "原书目录、插图和脚注直接保留；按需补充结构索引"}</small></span><input type="checkbox" data-file-parse="${index}" ${item.parse ? "checked" : ""}></label></div>`,
    )
    .join("");
  $("import-submit").disabled = !importFiles.length;
  $("import-submit").textContent = importFiles.length
    ? `导入 ${importFiles.length} 本书`
    : "导入书籍";
  $("import-count").textContent = importFiles.length
    ? `${importFiles.length} 个文件`
    : "文件保存在本机";
}
async function submitImport() {
  if (!importFiles.length) return;
  $("import-submit").disabled = true;
  const results = [];
  for (const [index, item] of importFiles.entries()) {
    try {
      $("import-result").textContent =
        `正在导入 ${index + 1} / ${importFiles.length}：${item.file.name}`;
      const parameters = new URLSearchParams({
        name: item.file.name,
        parse: item.parse ? "1" : "0",
        shelf: item.shelf,
      });
      const response = await api("/api/import?" + parameters, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: item.file,
      });
      results.push(
        `${response.duplicate ? "已在书库中" : "已导入"}：${response.book.title}`,
      );
    } catch (error) {
      results.push(`${item.file.name}：${error.message}`);
    }
  }
  $("import-result").textContent = results.join("\n");
  $("import-submit").textContent = "导入完成";
  await refreshLibrary();
  renderLibrary();
}
function openBookOptions(id) {
  editingBook = books.find((book) => book.id === id);
  if (!editingBook) return;
  const book = editingBook;
  $("book-form").innerHTML =
    `<label>书名<input id="book-name" type="text" value="${escapeHTML(book.title)}" maxlength="240"></label><label>书籍类别<select id="book-shelf"><option ${book.shelf === "小说" ? "selected" : ""}>小说</option><option ${book.shelf === "学习" ? "selected" : ""}>学习</option></select></label><label class="parse-toggle"><span>文档解析<small>${book.type === "pdf" ? "扫描文字按页准备，可补充原书目录" : book.type === "txt" ? "识别章、回、卷，建立章节导航" : "沿用原书内容，可额外补充结构索引"}</small></span><input id="book-parse" type="checkbox" ${book.parseEnabled ? "checked" : ""}></label>${book.type === "pdf" ? `<label>印刷书页到 PDF 页序的偏移<input id="book-offset" type="number" value="${book.pageOffset ?? ""}" placeholder="自动识别中；也可手动校正"></label><p class="setting-note">例如书页 3 位于 PDF 第 5 页，偏移填写 2。</p>` : ""}<div class="book-details">${escapeHTML(book.format)} · ${book.type === "pdf" ? book.pages + " 页" : book.chapters.length + " 个阅读单元"}<br>${escapeHTML(book.processingNote || "原文件保留在本机。")}</div>`;
  $("book-save-note").textContent = "更改不会修改原文件";
  $("book-dialog").showModal();
}
async function saveBookOptions() {
  await savePosition(true);
  const patch = {
    title: $("book-name").value.trim() || editingBook.title,
    shelf: $("book-shelf").value,
    parseEnabled: $("book-parse").checked,
  };
  if ($("book-offset")?.value !== " " && $("book-offset")?.value)
    patch.pageOffset = Number($("book-offset").value);
  try {
    await post("/api/books/" + editingBook.id, patch);
    $("book-dialog").close();
    await refreshLibrary();
    if (route === "reader" && current?.id === editingBook.id) {
      location = initialLocation(current);
      renderCurrent(location);
    } else renderLibrary();
    toast("书籍设置已保存。");
  } catch (error) {
    $("book-save-note").textContent = error.message;
  }
}

let formatInfo = [];
async function refreshLibrary() {
  const data = await api("/api/library");
  const previous = current;
  books = data.books;
  jobs = data.jobs;
  if (previous) {
    const replacement = books.find((book) => book.id === previous.id);
    if (replacement) {
      if (
        previous.loaded &&
        previous.contentUrl === replacement.contentUrl &&
        previous.parseEnabled === replacement.parseEnabled &&
        previous.chapters?.length === replacement.chapters?.length
      ) {
        replacement.chapters = previous.chapters;
        replacement.loaded = true;
      }
      current = replacement;
    }
  }
  renderJobs();
  if (route === "reader" && current) renderToc();
  return data;
}
function validatePreferences(input) {
  const output = { ...defaults, ...input };
  for (const key of ["textMode", "palmMode", "pdfMode"])
    if (!["pages", "scroll"].includes(output[key])) output[key] = defaults[key];
  if (!["paper", "sage", "blue", "night"].includes(output.theme))
    output.theme = "paper";
  if (!["han-serif", "han-sans", "wenkai", "system"].includes(output.zhFont))
    output.zhFont = "han-serif";
  if (
    !["literata", "source-serif", "georgia", "system"].includes(output.enFont)
  )
    output.enFont = "literata";
  for (const [key, min, max] of [
    ["fontSize", 16, 30],
    ["lineHeight", 1.5, 2.4],
    ["textWidth", 480, 860],
    ["pdfZoom", 75, 180],
    ["palmScale", 0.85, 1.25],
  ])
    output[key] = clamp(output[key], min, max);
  return output;
}

function handleKeydown(event) {
  lastInput = Date.now();
  const editing =
    event.target.matches?.("input,textarea,select") ||
    event.target.isContentEditable;
  if (event.key === "Escape") {
    $("reader-aside").hidden = true;
    $("reader-settings").hidden = true;
    $("question-panel").hidden = true;
    $("selection-toolbar").hidden = true;
    $("reader").classList.remove("focused");
    $("focus-exit").hidden = true;
    return;
  }
  if (route !== "reader" || editing || event.isComposing) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    $("reader-aside").hidden = false;
    $("toc-search").focus();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
    event.preventDefault();
    toggleBookmark();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const selection = event.target.ownerDocument.defaultView.getSelection();
  if (selection && !selection.isCollapsed) return;
  if (["PageDown", "ArrowRight", " "].includes(event.key)) {
    event.preventDefault();
    flip(1);
  } else if (["PageUp", "ArrowLeft"].includes(event.key)) {
    event.preventDefault();
    flip(-1);
  } else if (event.key.toLowerCase() === "f" && !palm)
    setFocus(!$("reader").classList.contains("focused"));
}
function onCopy(event) {
  if (currentSelection && !event.target.closest?.("input,textarea")) {
    event.clipboardData.setData("text/plain", currentSelection.text);
    event.preventDefault();
  }
}
function setFocus(value) {
  const anchor = retainedAnchor || lastAnchor || captureAnchor();
  $("reader").classList.toggle("focused", value);
  $("focus-button").setAttribute("aria-pressed", String(value));
  $("focus-exit").hidden = !value;
  if (current?.type === "pdf") renderCurrent(location);
  else
    requestAnimationFrame(() => {
      configureTextLayout();
      restorePosition(() => restoreAnchor(anchor));
      updateProgress();
    });
}

document.addEventListener("click", async (event) => {
  const read = event.target.closest("[data-read]");
  if (read) {
    window.location.hash = "#/read/" + read.dataset.read;
    return;
  }
  const mini = event.target.closest("[data-palm]");
  if (mini) {
    openPalm(mini.dataset.palm);
    return;
  }
  const options = event.target.closest("[data-options]");
  if (options) {
    openBookOptions(options.dataset.options);
    return;
  }
  const star = event.target.closest("[data-star]");
  if (star) {
    const book = books.find((book) => book.id === star.dataset.star);
    try {
      const response = await post("/api/books/" + book.id, {
        onShelf: !book.onShelf,
      });
      Object.assign(book, response.book);
      renderLibrary();
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  const size = event.target.closest("[data-window-size]");
  if (size && native) {
    window.webkit.messageHandlers.readerNative.postMessage({
      action: "resize",
      compact: size.dataset.windowSize === "compact",
    });
    return;
  }
  const theme = event.target.closest("button[data-theme]");
  if (theme) {
    changePreference("theme", theme.dataset.theme);
    return;
  }
  if (event.target.closest("[data-fit]")) changePreference("pdfZoom", 100);
});
document.addEventListener("input", (event) => {
  const key = event.target.dataset.pref;
  if (
    !key ||
    event.target.tagName === "SELECT" ||
    event.target.type === "checkbox"
  )
    return;
  changePreference(key, Number(event.target.value));
});
document.addEventListener("change", (event) => {
  const key = event.target.dataset.pref;
  if (key)
    changePreference(
      key,
      event.target.type === "checkbox"
        ? event.target.checked
        : event.target.tagName === "SELECT"
          ? event.target.value
          : Number(event.target.value),
    );
  if (event.target.dataset.fileParse !== undefined)
    importFiles[Number(event.target.dataset.fileParse)].parse =
      event.target.checked;
  if (event.target.dataset.fileShelf !== undefined)
    importFiles[Number(event.target.dataset.fileShelf)].shelf =
      event.target.value;
});
$("library-search").addEventListener("input", renderLibrary);
$("shelf-filters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (button) {
    shelfFilter = button.dataset.filter;
    renderLibrary();
  }
});
["import-open", "imports-add"].forEach((id) => ($(id).onclick = openImport));
$("file-input").addEventListener("change", (event) => {
  addFiles(event.target.files);
  event.target.value = "";
});
$("drop-zone").addEventListener("dragover", (event) => {
  event.preventDefault();
  $("drop-zone").classList.add("dragging");
});
$("drop-zone").addEventListener("dragleave", () =>
  $("drop-zone").classList.remove("dragging"),
);
$("drop-zone").addEventListener("drop", (event) => {
  event.preventDefault();
  $("drop-zone").classList.remove("dragging");
  addFiles(event.dataTransfer.files);
});
$("import-submit").onclick = submitImport;
$("book-save").onclick = saveBookOptions;
$("reader-home").onclick = () => {
  savePosition(true);
  window.location.hash = "#/library";
};
$("reader-back").onclick = goBack;
$("toc-toggle").onclick = () => {
  $("reader-aside").hidden = !$("reader-aside").hidden;
  $("toc-toggle").setAttribute(
    "aria-expanded",
    String(!$("reader-aside").hidden),
  );
};
$("toc-close").onclick = () => ($("reader-aside").hidden = true);
$("toc-search").addEventListener("input", renderToc);
$("toc-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-index]");
  if (button?.dataset.index)
    navigate(Number(button.dataset.index), {
      fragment: button.dataset.fragment,
    });
});
["toc", "bookmark"].forEach(
  (tab) =>
    ($(tab + "-tab").onclick = () => {
      $("toc-tab").setAttribute("aria-selected", String(tab === "toc"));
      $("bookmark-tab").setAttribute(
        "aria-selected",
        String(tab === "bookmark"),
      );
      $("toc-list").hidden = tab !== "toc";
      $("bookmarks-list").hidden = tab !== "bookmark";
      document.querySelector(".toc-search").hidden = tab !== "toc";
    }),
);
$("bookmarks-list").addEventListener("click", async (event) => {
  const remove = event.target.closest("[data-remove-mark]");
  if (remove) {
    bookmarks = bookmarks.filter(
      (mark) => mark.id !== remove.dataset.removeMark,
    );
    await postState({
      bookmarkChanges: { remove: [remove.dataset.removeMark] },
    });
    renderBookmarks();
    return;
  }
  const button = event.target.closest("[data-mark]");
  const mark =
    button && bookmarks.find((mark) => mark.id === button.dataset.mark);
  if (mark) navigate(mark.position.index, mark.position);
});
$("bookmark-button").onclick = toggleBookmark;
$("palm-open").onclick = () => openPalm(current.id);
$("book-options").onclick = () => openBookOptions(current.id);
$("focus-button").onclick = () =>
  setFocus(!$("reader").classList.contains("focused"));
$("focus-exit").onclick = () => setFocus(false);
$("reader-settings-open").onclick = () =>
  ($("reader-settings").hidden = !$("reader-settings").hidden);
$("reader-settings-close").onclick = () => ($("reader-settings").hidden = true);
$("palm-settings").onclick = () =>
  ($("reader-settings").hidden = !$("reader-settings").hidden);
$("page-label").onclick = () => {
  if (!readerReady) return;
  const total = pagination?.count || count(current);
  $("page-jump-label").textContent =
    current.type === "pdf"
      ? "PDF 文件页序"
      : pagination
        ? "本章页码"
        : "章节序号";
  $("page-jump-input").max = total;
  $("page-jump-input").value = pagination
    ? pagination.page + 1
    : location.index;
  $("page-jump-total").textContent =
    `共 ${total} ${current.type === "pdf" || pagination ? "页" : "章"}`;
  $("page-dialog").showModal();
  $("page-jump-input").select();
};
$("page-jump-close").onclick = () => $("page-dialog").close();
$("page-jump-form").onsubmit = (event) => {
  event.preventDefault();
  const page = Number($("page-jump-input").value);
  $("page-dialog").close();
  if (pagination) {
    history.push(snapshot());
    retainedAnchor = null;
    pagination.set(page - 1, true);
    lastAnchor = captureAnchor();
    updateProgress();
    saveTimer = setTimeout(() => savePosition().catch(() => {}), 400);
    $("reader-back").disabled = false;
  } else navigate(page);
};
$("previous-button").onclick = $("palm-previous").onclick = () => flip(-1);
$("next-button").onclick = $("palm-next").onclick = () => flip(1);
$("next-chapter").onclick = () => navigate(location.index + 1, {}, false);
$("palm-pin").hidden = !native;
$("palm-pin").onclick = () =>
  window.webkit.messageHandlers.readerNative.postMessage({ action: "pin" });
$("palm-close").onclick = async () => {
  await savePosition();
  if (native)
    window.webkit.messageHandlers.readerNative.postMessage({ action: "close" });
  else window.close();
};
$("palm-bar").hidden = !palm;
$("palm-footer").hidden = !palm;
document.addEventListener("mouseup", (event) => {
  if (
    route === "reader" &&
    !event.target.closest(
      ".selection-toolbar,.pdf-object,.reader-settings,.question-panel",
    )
  )
    setTimeout(() => captureSelection(), 10);
});
$("selection-toolbar").onmousedown = (event) => event.preventDefault();
$("copy-selection").onclick = () =>
  currentSelection && copyText(currentSelection.text);
$("copy-image").onclick = copyImage;
$("ask-selection").onclick = () => {
  if (!currentSelection) return;
  questionContext = { ...currentSelection };
  $("question-source").textContent =
    questionContext.source + "\n\n" + questionContext.text;
  $("question-image").hidden = !questionContext.image;
  if (questionContext.image) $("question-image").src = questionContext.image;
  else $("question-image").removeAttribute("src");
  $("copy-question").textContent = questionContext.image
    ? "复制出处与问题"
    : "复制内容与问题";
  $("question-panel").hidden = false;
  $("selection-toolbar").hidden = true;
  $("question-input").focus();
};
$("question-close").onclick = () => ($("question-panel").hidden = true);
$("copy-question").onclick = () =>
  questionContext &&
  copyText(
    questionContext.source +
      "\n\n" +
      questionContext.text +
      "\n\n问题：" +
      $("question-input").value,
  );
document.addEventListener("keydown", handleKeydown);
document.addEventListener("copy", onCopy);
attachPageGestures($("reading-viewport"));
$("reading-mode").onclick = () =>
  changePreference(
    current.type === "pdf" ? "pdfMode" : palm ? "palmMode" : "textMode",
    readingMode() === "pages" ? "scroll" : "pages",
  );
$("reading-viewport").addEventListener(
  "scroll",
  () => {
    if (!readerReady || pagination) return;
    if (!restoringPosition) retainedAnchor = null;
    if (current?.type === "pdf" && prefs.pdfMode === "scroll")
      updatePdfScroll();
    lastAnchor = retainedAnchor || captureAnchor();
    updateProgress();
    $("selection-toolbar").hidden = true;
    clearTimeout(saveTimer);
    if (!restoringPosition)
      saveTimer = setTimeout(() => savePosition().catch(() => {}), 250);
  },
  { passive: true },
);
window.addEventListener("palm-resume", async () => {
  const state = await api("/api/state");
  positions = state.positions || positions;
  location = initialLocation(current);
  renderCurrent(location);
});
window.addEventListener("palm-flip", (event) => flip(Number(event.detail)));
window.addEventListener("palm-pin", (event) => {
  $("palm-pin").setAttribute("aria-pressed", String(event.detail));
  $("palm-pin").setAttribute(
    "aria-label",
    event.detail ? "取消置顶" : "窗口置顶",
  );
});
let resizeTimer;
window.addEventListener("resize", () => {
  const anchor = lastAnchor || captureAnchor();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(async () => {
    applyPreferences();
    if (route !== "reader" || !current) return;
    if (current.type === "pdf") {
      renderCurrent(makePosition());
      return;
    }
    if (current.type === "epub") await styleEpub();
    configureTextLayout();
    restorePosition(() => restoreAnchor(anchor));
    lastAnchor = retainedAnchor || captureAnchor();
    updateProgress();
    reportNative();
  }, 80);
});
window.addEventListener("hashchange", showRoute);
window.addEventListener("pagehide", () => {
  if (current && readerReady) {
    const position = makePosition();
    navigator.sendBeacon(
      "/api/state",
      JSON.stringify({
        writer,
        positions: { [current.id]: position },
        lastBook: current.id,
      }),
    );
  }
});
$("timer-button").onclick = () => {
  if (timerRunning) {
    timerRemaining = Math.max(
      0,
      Math.ceil((timerDeadline - Date.now()) / 1000),
    );
    timerRunning = false;
  } else {
    if (!timerRemaining) timerRemaining = 1500;
    timerDeadline = Date.now() + timerRemaining * 1000;
    timerRunning = true;
  }
  updateTimer();
};
function updateTimer() {
  if (timerRunning) {
    timerRemaining = Math.max(
      0,
      Math.ceil((timerDeadline - Date.now()) / 1000),
    );
    if (!timerRemaining) {
      timerRunning = false;
      toast("25 分钟到了，歇一会儿再读。");
    }
  }
  $("timer-label").textContent =
    timerRunning || timerRemaining < 1500
      ? `${String(Math.floor(timerRemaining / 60)).padStart(2, "0")}:${String(timerRemaining % 60).padStart(2, "0")}${timerRunning ? "" : " · 已暂停"}`
      : "专注一会儿";
  $("timer-button").classList.toggle("running", timerRunning);
}

async function poll() {
  try {
    const version = await api("/api/library-version");
    if (version.revision !== libraryRevision) {
      libraryRevision = version.revision;
      const previousFlag = current?.parseEnabled,
        previousCount = current?.chapters?.length;
      await refreshLibrary();
      if (route === "library" || route === "shelf") renderLibrary();
      if (
        route === "reader" &&
        current &&
        (previousFlag !== current.parseEnabled ||
          (current.type === "txt" && previousCount !== current.chapters.length))
      ) {
        location = initialLocation(current);
        renderCurrent(location);
      }
    }
    const state = await api("/api/state");
    if (state.revision <= stateRevision) return;
    stateRevision = state.revision;
    const remote = current && state.positions?.[current.id];
    positions = state.positions || positions;
    bookmarks = state.bookmarks || bookmarks;
    if (state.writer !== writer) {
      const previousPrefs = prefs;
      const changed =
        JSON.stringify(prefs) !==
        JSON.stringify(validatePreferences(state.prefs || {}));
      prefs = validatePreferences(state.prefs || {});
      if (changed) {
        const anchor = lastAnchor || captureAnchor();
        applyPreferences();
        renderSettings();
        if (route === "reader" && current) {
          if (current.type === "pdf") {
            if (
              previousPrefs.pdfMode !== prefs.pdfMode ||
              previousPrefs.pdfZoom !== prefs.pdfZoom
            )
              await renderCurrent(makePosition());
          } else {
            if (current.type === "epub") await styleEpub();
            configureTextLayout();
            restorePosition(() => restoreAnchor(anchor));
            updateProgress();
          }
        }
      }
      if (
        route === "reader" &&
        remote?.updatedAt > (location?.updatedAt || 0) &&
        !document.hasFocus() &&
        Date.now() - lastInput > 1000
      ) {
        location = initialLocation(current);
        if (location.index !== Number($("page-label").dataset.chapter))
          renderCurrent(location);
        else {
          retainedAnchor = location.anchor || null;
          restorePosition(() => {
            if (current.type === "pdf") scrollPdfTo(location);
            else revealPosition(location);
          });
          lastAnchor = retainedAnchor || captureAnchor();
          updateProgress();
        }
      }
      if (route === "library" || route === "shelf") renderLibrary();
      renderBookmarks();
    }
  } catch {}
}

try {
  const [collection, formats, rawState] = await Promise.all([
    api("/api/library"),
    api("/api/formats"),
    api("/api/state"),
  ]);
  books = collection.books;
  jobs = collection.jobs;
  formatInfo = formats.formats;
  $("file-input").accept = formatInfo.map((info) => info.extension).join(",");
  $("formats-note").textContent =
    "可导入：" +
    formatInfo
      .map((info) => info.extension.slice(1).toUpperCase())
      .join(" · ") +
    "。EPUB 直接使用原书内容，其他格式先通过对应的本地适配器读取。";
  const state = rawState;
  prefs = validatePreferences(state.prefs || {});
  positions = state.positions || {};
  bookmarks = (state.bookmarks || []).filter(
    (mark) => mark.position && books.some((book) => book.id === mark.book),
  );
  stateRevision = state.revision || 0;
  current = books.find((book) => book.id === state.lastBook) || books[0];
  location = current ? initialLocation(current) : null;
  applyPreferences();
  renderSettings();
  renderJobs();
  $("startup").hidden = true;
  showRoute();
  setInterval(updateTimer, 1000);
  setInterval(poll, 1800);
  window.addEventListener("focus", poll);
} catch (error) {
  $("startup").textContent =
    "新版需要本地阅读服务。请双击 start.command 启动，再刷新页面。 " +
    error.message;
  console.error(error);
}
