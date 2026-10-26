import * as pdfjs from "/assets/vendor/pdf.mjs";
import {
  clamp,
  chapterProgress,
  palmTypography,
  shouldFollowPosition,
  textChapterIndex,
  sliceText,
} from "/core.mjs";
import { escapeHTML, icon } from "/ui/shared.mjs";
import { createLibraryView } from "/ui/library.mjs";
import { createToasts } from "/ui/feedback.mjs";
import { createTutor } from "/ui/tutor.mjs";
import { createServiceSettings } from "/ui/settings.mjs";
import { createDocumentParsing, formatPages } from "/ui/mineru.mjs";
import { copyPng } from "/ui/clipboard.mjs";
import {
  renderOcrLayer,
  ocrTextUnits,
  paintOcrSelection,
} from "/ui/ocr-layer.mjs";
import {
  alignTextLayer,
  canonicalSelection,
  canonicalPosition,
} from "/ui/pdf-selection.mjs";
import { createBookSearch, decorateReferences } from "/ui/knowledge.mjs";
import { createBookExport } from "/ui/export.mjs";
import { createDataSettings } from "/ui/data.mjs";
import { createChapterEditor } from "/ui/chapters.mjs";
import { taskEntries } from "/ui/jobs.mjs";
import { flatToc, fragmentTarget, epubTocAtAnchor } from "/ui/navigation.mjs";
import { PageLayout, characterRect } from "/page-layout.mjs?v=2.32";

pdfjs.GlobalWorkerOptions.workerSrc = "/assets/vendor/pdf.worker.mjs";
const $ = (id) => document.getElementById(id);
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
const desktop = native || !!window.webkit?.messageHandlers?.appNative;
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
  palmKeys: "arrows",
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
  lastAnchor,
  pendingAnchor;
let saveTimer,
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
  stateWrites = 0,
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
  pendingFlip = 0,
  retainedAnchor = null;
const pdfs = new Map(),
  ocrCache = new Map();
document.body.dataset.readerBuild = "2.32";
document.body.dataset.mode = palm ? "palm" : "standard";
document.body.dataset.native = String(native);

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "操作没有完成，请重试。");
    error.data = data;
    throw error;
  }
  return data;
}
function post(path, value) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}
const toast = createToasts($("toasts"));
const dataSettings = createDataSettings({ api, post, toast });
const bookExport = createBookExport({
  post,
  getBook: (id) => books.find((book) => book.id === id),
  toast,
});
const chapterEditor = createChapterEditor({
  post,
  toast,
  getBook: (id) => books.find((book) => book.id === id),
  beforeChange: async (id) => {
    const position =
      current?.id === id && readerReady ? makePosition() : positions[id];
    await savePosition(true);
    return position;
  },
  changed: async (id, position) => {
    await refreshLibrary();
    if (route === "reader" && current?.id === id)
      await renderCurrent(position || initialLocation(current));
    else if (route === "library") renderLibrary();
  },
});
const bookSearch = createBookSearch({
  post,
  toast,
  getContext: () =>
    current && readerReady
      ? { book: current.id, type: current.type, position: makePosition() }
      : null,
  openSource: (book, position) => {
    if (current?.id === book) navigate(position.index, position);
  },
});
const serviceSettings = createServiceSettings({ document, api, post, toast });
const documentParsing = createDocumentParsing({
  document,
  api,
  post,
  toast,
  getBook: (id) => books.find((book) => book.id === id),
  getPosition: (id) =>
    current?.id === id && readerReady ? makePosition() : positions[id],
  refresh: async () => {
    const previous = current;
    const position = current && readerReady ? makePosition() : null;
    await refreshLibrary();
    if (
      route === "reader" &&
      current?.type === "pdf" &&
      current.id === previous?.id
    ) {
      if (previous.parseEnabled !== current.parseEnabled)
        await renderCurrent(position || location);
      else if (previous.enhancementRevision !== current.enhancementRevision)
        refreshPdfEnhancements();
    }
    renderJobs();
    if (route === "library") renderLibrary();
  },
});
const libraryView = createLibraryView(document);
function postState(patch) {
  stateWrites++;
  stateQueue = stateQueue
    .catch(() => {})
    .then(() => post("/api/state", { ...patch, writer }))
    .then((data) => {
      stateRevision = Math.max(stateRevision, data.revision || 0);
      return data;
    })
    .finally(() => {
      stateWrites--;
    });
  return stateQueue;
}
function count(book) {
  return book.type === "pdf" ? book.pages : book.chapters.length;
}
function chapterTitle(book = current, index = location?.index) {
  if (!book) return "";
  if (
    book.type === "epub" &&
    book === current &&
    index === location?.index &&
    readerReady
  )
    return (
      activeTocItem()?.title || book.chapters[index - 1]?.title || book.title
    );
  if (book.type !== "pdf")
    return book.chapters[clamp(index, 1, count(book)) - 1]?.title || book.title;
  return (
    flatToc(book.toc || [])
      .filter((item) => item.index && item.index <= index)
      .sort((a, b) => a.index - b.index)
      .at(-1)?.title || "原书页面"
  );
}
function activeTocItem() {
  if (!current || !location) return null;
  if (current.type !== "epub")
    return (
      flatToc(current.toc || [])
        .filter((item) => item.index && item.index <= location.index)
        .sort((a, b) => a.index - b.index)
        .at(-1) || null
    );
  const doc =
    readerReady &&
    !location.resource &&
    $("epub-frame").dataset.chapter ===
      current.chapters[location.index - 1]?.url
      ? frameDocument()
      : null;
  const anchor = retainedAnchor || lastAnchor;
  const element =
    doc &&
    anchor &&
    (Number.isSafeInteger(anchor.sourceNode)
      ? doc.querySelector(`[data-source-node="${anchor.sourceNode}"]`)
      : readingElements()[anchor.index]);
  let fragment = location.fragment;
  if (doc && fragment) {
    const target = fragmentTarget(doc, fragment);
    const rectangle =
      target && (characterRect(target) || target.getClientRects()[0]);
    const frame = $("epub-frame").getBoundingClientRect(),
      view = $("reading-viewport").getBoundingClientRect();
    if (
      !rectangle ||
      rectangle.left + frame.left < view.left ||
      rectangle.left + frame.left > view.right ||
      rectangle.top + frame.top < view.top ||
      rectangle.top + frame.top > view.bottom
    )
      fragment = "";
  }
  return epubTocAtAnchor(current.toc || [], location.index, {
    doc,
    element,
    offset: anchor?.charOffset || 0,
    fragment,
  });
}

function updateTocActive(active = activeTocItem()) {
  const index = flatToc(current?.toc || []).indexOf(active);
  const list = $("toc-list"),
    previous = list.querySelector('[aria-current="true"]');
  if (previous?.dataset.tocEntry === String(index)) return;
  previous?.classList.remove("active");
  previous?.removeAttribute("aria-current");
  const button = list.querySelector(`[data-toc-entry="${index}"]`);
  if (!button) return;
  button.classList.add("active");
  button.setAttribute("aria-current", "true");
  for (
    let parent = button.parentElement;
    parent && parent !== list;
    parent = parent.parentElement
  )
    if (parent.tagName === "DETAILS") parent.open = true;
}
function initialLocation(book) {
  const saved = positions[book.id] || {};
  let index = clamp(saved.index || 1, 1, count(book));
  if (book.type === "txt" && Number.isFinite(saved.sourceOffset)) {
    index = textChapterIndex(book.chapters, saved.sourceOffset);
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
function renderLibrary() {
  const last =
    books.find((book) => book.id === current?.id) ||
    books.find((book) => positions[book.id]) ||
    books[0];
  libraryView.render({
    books,
    filter: shelfFilter,
    query: $("library-search").value,
    last,
    progress: progressFor,
    detail: (book) => chapterTitle(book, positions[book.id]?.index || 1),
  });
}
function renderJobs() {
  const entries = taskEntries(books, jobs);
  const running = entries.filter((job) => job.status === "running").length;
  const failed = entries.filter((job) => job.status === "error").length;
  $("running-count").textContent = running || failed || "";
  $("running-count").hidden = !(running || failed);
  $("task-label").textContent = running
    ? "后台处理中"
    : failed
      ? "有任务待处理"
      : "导入与处理";
  $("jobs-open").dataset.state = running
    ? "running"
    : failed
      ? "error"
      : "ready";
  $("jobs-open").setAttribute(
    "aria-label",
    running
      ? `${running} 项后台处理任务，点击查看`
      : failed
        ? `${failed} 项任务待处理，点击查看`
        : "导入与处理任务",
  );
  $("import-jobs").innerHTML =
    entries
      .map(
        (job) =>
          `<article class="job-row"><span class="job-label ${escapeHTML(job.status)}">${job.status === "running" ? "处理中" : job.status === "error" ? "待处理" : job.status === "paused" ? "已暂停" : "可阅读"}</span><div class="job-copy"><strong>${escapeHTML(job.title)}</strong><p>${escapeHTML(job.phase)}</p></div><div class="job-actions">${job.kind === "mineru" && job.status === "running" ? `<button class="secondary-button" data-pause-job="${escapeHTML(job.book)}">暂停</button>` : job.kind === "mineru" && ["paused", "error"].includes(job.status) ? `<button class="secondary-button" data-cloud="${escapeHTML(job.book)}" data-pages="${escapeHTML(formatPages(job.pages))}">继续任务</button>` : job.status === "error" && job.kind !== "selection" ? `<button class="secondary-button" data-retry="${escapeHTML(job.book)}">重新解析</button><button class="secondary-button" data-options="${escapeHTML(job.book)}">书籍设置</button>` : ""}${books.find((book) => book.id === job.book)?.type === "pdf" ? `<button class="secondary-button" data-process="${escapeHTML(job.book)}">文档处理</button>` : ""}<button class="secondary-button" data-read="${escapeHTML(job.book)}">阅读</button></div></article>`,
      )
      .join("") ||
    '<div class="empty-state">还没有处理任务，导入一本书即可开始。</div>';
}
function openJobs() {
  renderJobs();
  $("jobs-dialog").showModal();
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
  }<section class="settings-section"><h2>掌上阅读</h2>${palm && native ? '<div class="window-sizes"><button class="secondary-button" data-window-size="compact">小巧</button><button class="secondary-button" data-window-size="standard">标准</button></div>' : ""}<p class="setting-note">独立小窗，默认置顶。窗口缩小时，字号会同步调整；阅读位置与主阅读器共享。</p>${
    desktop
      ? select("后台翻页", "palmKeys", [
          ["arrows", "⌃⌥⌘ ← / →"],
          ["letters", "⌃⌥⌘ P / N"],
          ["off", "关闭后台快捷键"],
        ])
      : ""
  }<p class="setting-note">聚焦小窗：← / → / 空格<br>${desktop ? (prefs.palmKeys === "off" ? "后台快捷键已关闭。" : `后台：Control + Option + Command + ${prefs.palmKeys === "letters" ? "P（上一页） / N（下一页）" : "← / →"}。小窗打开且正文就绪时生效。`) : "后台快捷键由 macOS 桌面窗口提供，可在掌上窗口的阅读设置中调整。"}</p></section>`;
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
          sourceNode: element.dataset.sourceNode
            ? Number(element.dataset.sourceNode)
            : undefined,
          quote: sliceText(element.textContent.trim(), 0, 60),
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
  const sourceElement =
    current.type === "epub" && Number.isSafeInteger(anchor.sourceNode)
      ? frameDocument()?.querySelector(
          `[data-source-node="${anchor.sourceNode}"]`,
        )
      : null;
  if (sourceElement) element = sourceElement;
  if (
    !sourceElement &&
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
    const line = characterRect(element, remaining);
    if (line) {
      const shift =
        element.ownerDocument === document
          ? 0
          : $("epub-frame").getBoundingClientRect().top;
      rect = { ...rect, top: line.top + shift };
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
  if (key === "palmKeys") {
    if (!["arrows", "letters", "off"].includes(value)) return;
    try {
      await postState({ prefs: { palmKeys: value } });
      prefs.palmKeys = value;
      reportNative();
    } catch (error) {
      toast(error.message, { kind: "error" });
    }
    renderSettings();
    return;
  }
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
        build: "2.32",
        book: current.id,
        index: location.index,
        fontSize: actualSize(),
        anchor: retainedAnchor || captureAnchor(),
        top: $("reading-viewport").scrollTop,
        mode: readingMode(),
        keys: prefs.palmKeys,
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
    blockOrder: undefined,
    blockOffset: undefined,
    top:
      current.type === "pdf" ? pdfLocalTop() : $("reading-viewport").scrollTop,
    pdfY:
      current.type === "pdf"
        ? clamp(
            pdfLocalTop() /
              Math.max(1, pdfPageElement(location.index)?.offsetHeight || 1),
            0,
            1,
          )
        : undefined,
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
  const active = activeTocItem(),
    title = active?.title || chapterTitle();
  updateTocActive(active);
  $("progress-fill").style.width = `${progress * 100}%`;
  $("page-label").textContent = pagination
    ? `${pagination.page + 1} / ${pagination.count} 页`
    : `${location.index} / ${count(current)}`;
  $("page-label").dataset.chapter = location.index;
  $("palm-position").textContent = pagination
    ? `${pagination.page + 1} / ${pagination.count} · ${Math.round(progress * 100)}%`
    : `${title} · ${Math.round(progress * 100)}%`;
  $("position-label").textContent =
    current.type === "pdf"
      ? `${current.pageOffset !== null && location.index > current.pageOffset ? "书页 " + (location.index - current.pageOffset) : "PDF 第 " + location.index + " 页"} · ${title}`
      : title;
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
  const entries = new Map(
    flatToc(current.toc || []).map((item, index) => [item, index]),
  );
  const active = activeTocItem();
  function node(item, inherited = false) {
    const matches = inherited || item.title.toLocaleLowerCase().includes(text);
    const children = (item.children || [])
      .map((child) => node(child, matches))
      .join("");
    if (text && !matches && !children) return "";
    const currentItem = active === item;
    const row = `<button class="toc-item${currentItem ? " active" : ""}" data-toc-entry="${entries.get(item)}" data-index="${item.index || ""}" data-fragment="${escapeHTML(item.fragment || "")}" ${!item.index ? "disabled" : ""} ${currentItem ? 'aria-current="true"' : ""}><span>${escapeHTML(item.title)}</span>${item.printed ? `<small>${escapeHTML(item.printed)}</small>` : ""}</button>`;
    if (!item.children?.length) return row;
    const open = !!text || flatToc([item]).includes(active);
    return `<details ${open ? "open" : ""}><summary><span>${escapeHTML(item.title)}</span>${item.printed ? `<small>${escapeHTML(item.printed)}</small>` : ""}</summary>${item.index ? `<button class="toc-item${currentItem ? " active" : ""}" data-toc-entry="${entries.get(item)}" data-index="${item.index}" data-fragment="${escapeHTML(item.fragment || "")}" ${currentItem ? 'aria-current="true"' : ""}><span>${current.type === "pdf" ? "本章起始页" : "从这里阅读"}</span></button>` : ""}${children}</details>`;
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
    "txt-manual": "已调整的章节目录",
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
  $("toc-edit").hidden = current.type !== "txt";
  renderBookmarks();
}
function samePlace(a, b) {
  if (
    current.type === "txt" &&
    Number.isFinite(a.sourceOffset) &&
    Number.isFinite(b.sourceOffset)
  )
    return Math.abs(a.sourceOffset - b.sourceOffset) < 20;
  if (a.index !== b.index) return false;
  if (current.type === "pdf" || !a.anchor || !b.anchor)
    return Math.abs((a.top || 0) - (b.top || 0)) < 80;
  return (
    (a.anchor.sourceNode ?? a.anchor.index) ===
      (b.anchor.sourceNode ?? b.anchor.index) &&
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
          `<div class="bookmark-row"><button class="bookmark-open" data-mark="${escapeHTML(mark.id)}">${escapeHTML(mark.label)}<small>${escapeHTML(mark.detail)}</small></button><button class="icon-button" data-remove-mark="${escapeHTML(mark.id)}" aria-label="删除书签">${icon("close")}</button></div>`,
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
    await removeBookmark(mark.id);
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
    try {
      await postState({ bookmarkChanges: { add: [added] } });
      if (!bookmarks.some((item) => item.id === added.id))
        bookmarks.push(added);
      toast("已为这里留下书签。", { kind: "success" });
    } catch (error) {
      toast(error.message, { kind: "error" });
    }
  }
  renderBookmarks();
}
async function removeBookmark(id) {
  const mark = bookmarks.find((item) => item.id === id);
  if (!mark) return;
  try {
    await postState({ bookmarkChanges: { remove: [id] } });
    bookmarks = bookmarks.filter((item) => item.id !== id);
    renderBookmarks();
    toast("书签已移除。", {
      undo: async () => {
        await postState({ bookmarkChanges: { add: [mark] } });
        if (!bookmarks.some((item) => item.id === id)) bookmarks.push(mark);
        renderBookmarks();
      },
    });
  } catch (error) {
    toast(error.message, { kind: "error" });
  }
}

const pinning = new Set();
async function setPinned(id, pinned, offerUndo = true) {
  if (pinning.has(id)) throw new Error("这本书正在保存，请稍后重试。");
  pinning.add(id);
  const button = document.querySelector(`[data-star="${CSS.escape(id)}"]`);
  button?.setAttribute("aria-busy", "true");
  const previous = !!books.find((book) => book.id === id)?.onShelf;
  try {
    const response = await post("/api/books/" + id, { onShelf: pinned });
    const book = books.find((item) => item.id === id);
    if (book) book.onShelf = response.book.onShelf;
    renderLibrary();
    if (offerUndo)
      toast(pinned ? "已加入常读。" : "已移出常读。", {
        focusTarget: button,
        undo: async () => {
          if (!!books.find((item) => item.id === id)?.onShelf !== pinned)
            throw new Error("常读状态已再次更改，已保留最新选择。");
          await setPinned(id, previous, false);
        },
      });
  } finally {
    pinning.delete(id);
    button?.removeAttribute("aria-busy");
  }
}

function dismissSelection() {
  currentSelection = null;
  $("selection-toolbar").hidden = true;
  document
    .querySelectorAll(".pdf-object.selected")
    .forEach((element) => element.classList.remove("selected"));
  const doc = $("epub-frame").contentDocument;
  doc
    ?.querySelectorAll("[data-reader-selected]")
    .forEach((element) => element.removeAttribute("data-reader-selected"));
}
function clearSelection() {
  dismissSelection();
  window.getSelection()?.removeAllRanges();
  try {
    $("epub-frame").contentWindow?.getSelection()?.removeAllRanges();
  } catch {}
}
function watchSelection(doc) {
  let dragging = false,
    highlightFrame,
    timer;
  const schedule = (event) => {
    if (
      event?.target?.closest?.(
        ".selection-toolbar,.question-panel,.reader-settings",
      )
    )
      return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (route === "reader" && !dragging) captureSelection(doc);
    }, 80);
  };
  doc.addEventListener("pointerdown", (event) => {
    if (
      event.target.closest?.(
        ".selection-toolbar,.question-panel,.reader-settings",
      )
    )
      return;
    dragging = true;
    if (!event.target.closest?.(".pdf-object")) dismissSelection();
  });
  doc.addEventListener("pointerup", (event) => {
    dragging = false;
    schedule(event);
  });
  doc.addEventListener("pointercancel", () => {
    dragging = false;
  });
  doc.addEventListener("selectionchange", () => {
    const selection = doc.getSelection();
    if (doc === document && !highlightFrame)
      highlightFrame = requestAnimationFrame(() => {
        highlightFrame = null;
        paintOcrSelection($("pdf-paper"), doc.getSelection());
      });
    if (
      (!selection?.rangeCount || selection.isCollapsed) &&
      currentSelection?.document === doc
    )
      dismissSelection();
    else if (!dragging) schedule();
  });
  // Mouseup also covers native text selection and accessibility-driven selection.
  doc.addEventListener("mouseup", schedule);
}
function selectionDetails(position) {
  const actual = { ...position };
  let label =
    current.type === "pdf"
      ? "PDF 第 " + actual.index + " 页"
      : current.chapters[actual.index - 1]?.title || current.title;
  if (current.type === "epub") {
    if (actual.resource) label = "原书附加内容";
    else if (
      $("epub-frame").dataset.chapter ===
      current.chapters[actual.index - 1]?.url
    ) {
      const doc = frameDocument(),
        anchor = actual.anchor;
      const element =
        anchor &&
        (Number.isSafeInteger(anchor.sourceNode)
          ? doc.querySelector(`[data-source-node="${anchor.sourceNode}"]`)
          : readingElements()[anchor.index]);
      const section = epubTocAtAnchor(current.toc || [], actual.index, {
        doc,
        element,
        offset: anchor?.charOffset || 0,
      });
      if (section) {
        actual.fragment = section.fragment || "";
        label = section.title;
      }
    }
  }
  return { position: actual, source: `《${current.title}》 · ${label}` };
}
function showToolbar(rectangle) {
  const bar = $("selection-toolbar");
  bar.hidden = false;
  $("copy-selection").hidden = currentSelection.kind === "image";
  $("copy-image").hidden = !currentSelection.image;
  $("chapter-start").hidden =
    current.type !== "txt" ||
    !current.parseEnabled ||
    !Number.isFinite(currentSelection.position?.sourceOffset);
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
function refreshSelectionToolbar() {
  const selected = document.querySelector(".pdf-object.selected");
  if (currentSelection && selected) {
    const rectangle = selected.getBoundingClientRect(),
      viewport = $("reading-viewport").getBoundingClientRect();
    if (rectangle.bottom > viewport.top && rectangle.top < viewport.bottom) {
      showToolbar(rectangle);
      return;
    }
  }
  $("selection-toolbar").hidden = true;
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
  const text =
    current.type === "pdf"
      ? canonicalSelection(range, root)
      : selection.toString().trim();
  if (!text) return;
  const pdfPage =
    range.startContainer.parentElement?.closest(".pdf-page")?.dataset.page;
  const position = {
    ...makePosition(),
    index: Number(pdfPage) || location.index,
  };
  if (pdfPage) {
    const page = pdfPageElement(Number(pdfPage));
    Object.assign(position, canonicalPosition(range, page));
    const rectangle = page.getBoundingClientRect(),
      selected = range.getClientRects()[0];
    if (selected && rectangle.height)
      position.pdfY = clamp(
        (selected.top - rectangle.top) / rectangle.height,
        0,
        1,
      );
  } else {
    const elements = readingElements(),
      element = elements
        .filter((element) => element.contains(range.startContainer))
        .at(-1);
    if (element) {
      const before = doc.createRange();
      before.selectNodeContents(element);
      before.setEnd(range.startContainer, range.startOffset);
      position.anchor = {
        index: elements.indexOf(element),
        sourceNode: element.dataset.sourceNode
          ? Number(element.dataset.sourceNode)
          : undefined,
        quote: sliceText(element.textContent.trim(), 0, 60),
        charOffset: before.toString().length,
        pixels: 0,
      };
      if (current.type === "txt")
        position.sourceOffset =
          Number(element.dataset.sourceOffset) + position.anchor.charOffset;
    }
  }
  currentSelection = {
    document: doc,
    text,
    kind: "text",
    ...selectionDetails(position),
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
    toast("已复制。", { kind: "success" });
  } catch {
    toast("请选中文字后按 ⌘C 复制。", { kind: "warning" });
  }
}
async function copyImage() {
  if (!currentSelection?.image) return;
  try {
    await copyPng(currentSelection.image);
    toast("原图已复制。", { kind: "success" });
  } catch {
    toast("图片暂时无法复制，可在原书中查看完整图像。", { kind: "warning" });
  }
}

function pdfObjectImage(root, bbox) {
  const source = root.parentElement?.querySelector("canvas");
  if (!source?.width) return null;
  const [x0, y0, x1, y1] = bbox;
  const width = Math.max(1, Math.ceil((x1 - x0) * source.width)),
    height = Math.max(1, Math.ceil((y1 - y0) * source.height));
  const scale = Math.min(1, 2048 / Math.max(width, height));
  const image = document.createElement("canvas");
  image.width = Math.ceil(width * scale);
  image.height = Math.ceil(height * scale);
  image
    .getContext("2d")
    .drawImage(
      source,
      x0 * source.width,
      y0 * source.height,
      width,
      height,
      0,
      0,
      image.width,
      image.height,
    );
  return image.toDataURL("image/png");
}
function renderObjects(blocks, viewport, root, page) {
  root.parentElement._readerBlocks = blocks;
  root.replaceChildren();
  for (const block of blocks.filter((block) =>
    ["equation", "image", "table"].includes(block.type),
  )) {
    const [x0, y0, x1, y1] = block.bbox,
      button = document.createElement("button");
    button.className = "pdf-object";
    button.setAttribute(
      "aria-label",
      block.type === "equation"
        ? "选择完整公式"
        : block.type === "table"
          ? "选择完整表格"
          : "选择完整插图",
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
        image: pdfObjectImage(root, block.bbox) || block.image,
        format: block.type === "equation" ? "latex" : null,
        position: {
          ...makePosition(),
          index: page,
          blockOrder: blocks.indexOf(block),
          blockOffset: 0,
          top: y0 * viewport.height,
          pdfY: y0,
        },
        source: `《${current.title}》 · PDF 第 ${page} 页`,
      };
      showToolbar(button.getBoundingClientRect());
    };
    root.append(button);
  }
}
function renderOCR(data, viewport, root) {
  renderOcrLayer(root, data, viewport, current.language);
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
  if (root.dataset.ocr === "loading") {
    showPdfOcrStatus(root);
    return;
  }
  root.dataset.ocr = "loading";
  const key = book.id + ":" + page;
  if (page === location.index) {
    $("ocr-status").textContent = "正在准备本页可选文字…";
    $("ocr-status").hidden = false;
  }
  try {
    if (!ocrCache.has(key))
      ocrCache.set(
        key,
        api(`/api/ocr?book=${book.id}&page=${page}&client=${writer}`).catch(
          (error) => {
            ocrCache.delete(key);
            throw error;
          },
        ),
      );
    const data = await ocrCache.get(key);
    if (
      revision !== renderRevision ||
      !current.parseEnabled ||
      !root.isConnected
    )
      return;
    let blocks = data.blocks;
    if (
      current.enrichmentUrl &&
      (book.enhancementRevision !== current.enhancementRevision || !blocks)
    ) {
      blocks = (await api(`/api/enrichment?book=${book.id}&page=${page}`))
        .blocks;
      if (revision !== renderRevision || !root.isConnected) return;
    }
    renderOCR(data, viewport, root.querySelector(".textLayer"));
    await alignTextLayer(
      root.querySelector(".textLayer"),
      blocks,
      post,
      book.id,
      page,
    );
    if (revision !== renderRevision || !root.isConnected) return;
    if (blocks)
      renderObjects(
        blocks,
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
        if (
          revision === renderRevision &&
          page === location.index &&
          root.dataset.ocr === "ready"
        )
          $("ocr-status").hidden = true;
      }, 1800);
    }
  } catch (error) {
    root.dataset.ocr = "error";
    root._ocrError = error.message;
    if (revision === renderRevision && page === location.index) {
      showPdfOcrStatus(root);
    }
  }
}
function showPdfOcrStatus(root) {
  if (!root || Number(root.dataset.page) !== location?.index) return;
  if (root.dataset.ocr === "loading") {
    clearTimeout(ocrTimer);
    $("ocr-status").textContent = `正在准备第 ${location.index} 页可选文字…`;
    $("ocr-status").hidden = false;
  } else if (root.dataset.ocr === "error") {
    const retry = document.createElement("button");
    retry.textContent = "重试本页";
    retry.onclick = () => {
      delete root.dataset.ocr;
      ensurePdfPages();
    };
    $("ocr-status").replaceChildren(
      document.createTextNode(root._ocrError + " "),
      retry,
    );
    $("ocr-status").hidden = false;
  } else if (["ready", "native"].includes(root.dataset.ocr))
    $("ocr-status").hidden = true;
}
let pdfWarmStamp = null,
  pdfWarmQueue = Promise.resolve(),
  pdfEnhancementTimer;
function warmPdfPages() {
  if (!current?.parseEnabled) return leavePdfPreparation();
  const stamp = current.id + ":" + location.index;
  if (stamp === pdfWarmStamp) return;
  pdfWarmStamp = stamp;
  const value = {
    action: "nearby",
    book: current.id,
    page: location.index,
    client: writer,
  };
  pdfWarmQueue = pdfWarmQueue
    .catch(() => {})
    .then(() => post("/api/pdf/prepare", value))
    .catch(() => {
      if (pdfWarmStamp === stamp) pdfWarmStamp = null;
    });
}
function leavePdfPreparation() {
  if (pdfWarmStamp === null) return;
  pdfWarmStamp = null;
  pdfWarmQueue = pdfWarmQueue
    .catch(() => {})
    .then(() => post("/api/pdf/prepare", { action: "leave", client: writer }))
    .catch(() => {});
}
async function refreshPdfObjects(book, root, revision) {
  if (!book.parseEnabled || !book.enrichmentUrl || !root?._viewport) return;
  const data = await api(
    `/api/enrichment?book=${book.id}&page=${root.dataset.page}`,
  );
  if (
    revision !== renderRevision ||
    current?.id !== book.id ||
    !root.isConnected
  )
    return;
  renderObjects(
    data.blocks,
    root._viewport,
    root.querySelector(".object-layer"),
    Number(root.dataset.page),
  );
  if (["native", "ready"].includes(root.dataset.ocr))
    await alignTextLayer(
      root.querySelector(".textLayer"),
      data.blocks,
      post,
      book.id,
      Number(root.dataset.page),
    );
}
function refreshPdfEnhancements() {
  clearTimeout(pdfEnhancementTimer);
  for (const key of ocrCache.keys())
    if (key.startsWith(current.id + ":")) ocrCache.delete(key);
  const book = current,
    revision = renderRevision;
  let deferred = false;
  for (const root of $("pdf-paper").children) {
    if (root.dataset.rendered !== "ready") continue;
    if (currentSelection?.position?.index === Number(root.dataset.page)) {
      deferred = true;
      continue;
    }
    refreshPdfObjects(book, root, revision).catch(() => {});
  }
  if (deferred)
    pdfEnhancementTimer = setTimeout(() => {
      if (
        revision === renderRevision &&
        route === "reader" &&
        current?.id === book.id
      )
        refreshPdfEnhancements();
    }, 500);
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
  const height = pdfPageElement(position.index)?.offsetHeight || 1;
  const top = Number.isFinite(position.pdfY)
    ? position.pdfY * height
    : position.top || 0;
  $("reading-viewport").scrollTop =
    pdfPageTop(position.index) + Math.min(top, Math.max(0, height - 20));
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
  refreshPdfObjects(current, root, revision).catch(() => {});
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
    prepareOcr(current, index, active._viewport, revision, active);
  }
  showPdfOcrStatus(active);
  warmPdfPages();
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
  if (position.anchor) {
    restoreAnchor(position.anchor);
    return;
  }
  if (position.fragment) {
    const doc = current.type === "epub" ? frameDocument() : document,
      target = fragmentTarget(doc, position.fragment);
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
  for (const key of [
    "--ink",
    "--paper",
    "--accent",
    "--selection",
    "--turn-shadow",
    "--turn-shade",
    "--turn-highlight",
  ])
    doc.documentElement.style.setProperty(key, colors.getPropertyValue(key));
  const fixed = current.layout === "pre-paginated";
  style.textContent = `.reader-flow{font:inherit;color:inherit;}.reader-flow :is(img,svg,table,figure){break-inside:avoid;}.reader-flow :is(h1,h2,h3,h4){break-after:avoid;}html{height:auto!important;min-height:0!important;margin:0!important;padding:0!important;overflow:hidden!important;background:${colors.getPropertyValue("--paper")}!important;color:${colors.getPropertyValue("--ink")}!important;font-size:${actualSize()}px!important;}body{height:auto!important;min-height:0!important;margin:0!important;padding:${padding}!important;box-sizing:border-box!important;font-family:${fontFamilies[prefs.enFont]},${fontFamilies[prefs.zhFont]},serif!important;font-size:${actualSize()}px!important;line-height:${palm ? 1.65 : prefs.lineHeight}!important;overflow-wrap:break-word!important;color:${colors.getPropertyValue("--ink")}!important;background:${colors.getPropertyValue("--paper")}!important;}img{max-width:100%!important;}svg[viewBox][height="100%"]{height:auto!important;max-width:100%!important;}p{font-family:inherit!important;line-height:${palm ? 1.65 : prefs.lineHeight}!important;}table{max-width:100%;}a{color:${colors.getPropertyValue("--accent")};} [data-reader-selected]{outline:2px solid ${colors.getPropertyValue("--accent")};outline-offset:3px;}::selection{background:var(--selection);}${prefs.theme === "night" ? "body :is(p,span,div,h1,h2,h3,h4,li,blockquote){color:inherit!important;background-color:transparent!important;}" : ""}${palm ? "h1{font-size:1.25em!important;}h2{font-size:1.15em!important;}h3{font-size:1.08em!important;}" : ""}${fixed ? "body{padding:0!important;}" : ""}${readingMode() === "pages" ? `html,body{width:100%!important;height:100%!important;padding:0!important;}#reader-flow{font:inherit;}.reader-flow :is(img,svg){max-height:${Math.max(80, $("reading-viewport").clientHeight - (palm ? 90 : 160))}px!important;object-fit:contain;}` : ""}`;
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
    for (const image of parsed.querySelectorAll("img[src]")) {
      const source = image.getAttribute("src");
      const recovered = source.replace(/^(?:\.{1,2}\/)+(data:image\/)/i, "$1");
      if (recovered !== source) image.setAttribute("src", recovered);
    }
    // WebKit needs allow-scripts for trusted parent listeners; book code stays removed and forbidden by CSP.
    parsed
      .querySelectorAll("script,iframe,object,embed,base")
      .forEach((element) => element.remove());
    for (const element of parsed.querySelectorAll("*"))
      for (const attribute of [...element.attributes])
        if (
          /^on/i.test(attribute.name) ||
          /^(srcdoc|autofocus|contenteditable)$/i.test(attribute.name) ||
          (/^(href|xlink:href|src|action|formaction)$/i.test(attribute.name) &&
            /^\s*javascript:/i.test(attribute.value))
        )
          element.removeAttribute(attribute.name);
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
    [...doc.body.querySelectorAll("p,h1,h2,h3,h4,blockquote,figure,table")]
      .filter((element) => !element.closest("nav"))
      .forEach((element, index) => {
        element.dataset.sourceNode = index;
      });
    const flow = doc.createElement("div");
    flow.id = "reader-flow";
    flow.append(...doc.body.childNodes);
    doc.body.append(flow);
    decorateReferences(flow);
    attachPageGestures(doc);
    watchSelection(doc);
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
  lastAnchor = retainedAnchor || captureAnchor();
  updateProgress();
}
function onEpubClick(event) {
  const reference = event.target.closest("[data-book-reference]");
  if (reference) {
    event.preventDefault();
    bookSearch.open(reference.dataset.bookReference);
    return;
  }
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
  } else if (tag === "img") {
    image = element.src;
    if (element.alt?.startsWith("LaTeX: ")) {
      kind = "equation";
      text = element.alt.slice(7);
      format = "latex";
    }
  } else {
    const embedded = element.querySelector("image");
    image = embedded
      ? new URL(
          embedded.getAttribute("href") || embedded.getAttribute("xlink:href"),
          frameDocument().baseURI,
        ).href
      : "data:image/svg+xml;charset=utf-8," +
        encodeURIComponent(new XMLSerializer().serializeToString(element));
  }
  const elements = readingElements();
  const owner = elements
    .filter((item) => item === element || item.contains(element))
    .at(-1);
  const position = makePosition();
  if (owner) {
    const before = element.ownerDocument.createRange();
    before.selectNodeContents(owner);
    if (owner !== element) before.setEndBefore(element);
    else before.collapse(true);
    position.anchor = {
      index: elements.indexOf(owner),
      sourceNode: owner.dataset.sourceNode
        ? Number(owner.dataset.sourceNode)
        : undefined,
      quote: sliceText(owner.textContent.trim(), 0, 60),
      charOffset: before.toString().length,
      pixels: 0,
    };
  }
  currentSelection = {
    kind,
    image,
    text: text || "[完整图像]",
    format,
    ...selectionDetails(position),
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
        p.dataset.sourceOffset =
          (chapter.sourceOffset || 0) +
          offset +
          text.length -
          text.trimStart().length;
        p.dataset.paragraph = index;
        offset += text.length;
        return p;
      }),
  );
  decorateReferences($("chapter-body"));
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
        quote: sliceText(element.textContent.trim(), 0, 60),
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
  if (current?.type === "txt" && Number.isFinite(position.sourceOffset)) {
    position = {
      ...position,
      index: textChapterIndex(current.chapters, position.sourceOffset),
    };
    location = position;
  }
  clearTimeout(saveTimer);
  pagination?.destroy();
  pagination = null;
  const revision = ++renderRevision;
  readerReady = false;
  $("reading-viewport").setAttribute("aria-busy", "true");
  $("bookmark-button").disabled = true;
  $("ai-open").disabled = true;
  $("knowledge-open").disabled = true;
  retainedAnchor = position.anchor || null;
  pendingAnchor = null;
  lastAnchor = null;
  clearSelection();
  if ($("question-panel").dataset.book !== current.id)
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
  $("reader-process").hidden = current.type !== "pdf";
  $("reader-loading").hidden = false;
  $("reader-loading").dataset.state = "loading";
  $("reader-loading").textContent =
    current.type === "pdf"
      ? "正在绘制原书页面…"
      : current.type === "epub"
        ? "正在加载原书章节与字体…"
        : "正在整理章节排版…";
  $("book-title").textContent = current.title;
  $("source-pdf-open").hidden =
    !current.sourcePdfHash ||
    !books.some(
      (book) =>
        book.type === "pdf" && book.sourceHash === current.sourcePdfHash,
    );
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
      leavePdfPreparation();
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
      `${chapterTitle(current, position.index)}暂时无法打开。${error.message || "请重新选择章节。"}`;
    $("reader-loading").dataset.state = "error";
    const retry = document.createElement("button");
    retry.className = "secondary-button";
    retry.textContent = "重新打开";
    retry.onclick = () => renderCurrent(location);
    $("reader-loading").append(retry);
    console.error(error);
  } finally {
    if (revision === renderRevision) {
      $("reading-viewport").setAttribute("aria-busy", "false");
      $("bookmark-button").disabled = !readerReady;
      $("ai-open").disabled = !readerReady;
      $("knowledge-open").disabled = !readerReady;
    }
  }
}
async function navigate(index, options = {}, record = true) {
  if (!current) return;
  const book = current.id;
  lastInput = Date.now();
  if (record && readerReady) history.push(snapshot());
  location = {
    ...options,
    index: clamp(index, 1, count(current)),
    top: options.top || 0,
    updatedAt: lastInput,
  };
  if (
    current.type === "pdf" &&
    readerReady &&
    prefs.pdfMode === "scroll" &&
    $("pdf-paper").dataset.book === current.id
  ) {
    restorePosition(() => scrollPdfTo(location));
    ensurePdfPages();
    updateProgress();
    $("reader-back").disabled = !history.length;
  } else {
    const rendering = renderCurrent(location),
      revision = renderRevision;
    await rendering;
    if (current?.id !== book || renderRevision !== revision) return;
  }
  // Restoring a target suppresses scroll saves, so commit navigation explicitly.
  if (readerReady) savePosition(true).catch((error) => toast(error.message));
  if (innerWidth < 760) setTocOpen(false);
}

async function flip(direction) {
  lastInput = Date.now();
  if (flipBusy) {
    pendingFlip = direction;
    return;
  }
  if (!readerReady) return;
  retainedAnchor = null;
  location.fragment = "";
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
  const book = current,
    revision = renderRevision;
  flipBusy = true;
  updateProgress();
  try {
    if (animated)
      await view
        .animate(
          [
            { opacity: 1, transform: "translateX(0)" },
            { opacity: 0.65, transform: `translateX(${-direction * 6}px)` },
          ],
          { duration: 180, easing: "ease-in-out" },
        )
        .finished.catch(() => {});
    if (route !== "reader" || current !== book || renderRevision !== revision)
      return;
    await navigate(
      location.index + direction,
      { end: direction < 0, top: direction < 0 ? Number.MAX_SAFE_INTEGER : 0 },
      false,
    );
    if (animated && route === "reader" && current === book)
      await view
        .animate(
          [
            { opacity: 0.65, transform: `translateX(${direction * 6}px)` },
            { opacity: 1, transform: "translateX(0)" },
          ],
          { duration: 300, easing: "cubic-bezier(.3,0,.15,1)" },
        )
        .finished.catch(() => {});
    saveTimer = setTimeout(() => savePosition().catch(() => {}), 230);
  } finally {
    flipBusy = false;
    updateProgress();
    const queued = pendingFlip;
    pendingFlip = 0;
    if (queued && route === "reader" && current === book && readerReady)
      queueMicrotask(() => flip(queued));
  }
}

function goBack() {
  const previous = history.pop();
  if (previous) {
    savePosition(true);
    const book = books.find((book) => book.id === previous.book);
    if (!book) return;
    if (current?.id !== book.id) readerReady = false;
    current = book;
    if (!palm) window.history.replaceState(null, "", "#/read/" + current.id);
    navigate(previous.position.index, previous.position, false);
  }
}
function setTocOpen(open) {
  $("reader-aside").hidden = !open;
  $("toc-toggle").setAttribute("aria-expanded", String(open));
}
async function readBook(id) {
  const book = books.find((book) => book.id === id);
  if (!book) return;
  savePosition();
  current = book;
  location = initialLocation(book);
  history = [];
  $("toc-search").value = "";
  setTocOpen(!palm);
  $("toc-tab").click();
  $("reader-settings").hidden = true;
  renderCurrent(location);
}
function showRoute() {
  const requested = window.location.hash.slice(2).split("/");
  if (!palm && ["shelf", "imports"].includes(requested[0])) {
    if (requested[0] === "shelf") shelfFilter = "pinned";
    window.history.replaceState(null, "", "#/library");
  }
  const next = palm
    ? "reader"
    : requested[0] === "read"
      ? "reader"
      : ["library", "settings"].includes(requested[0])
        ? requested[0]
        : "library";
  if (route === "reader" && next !== "reader") {
    leavePdfPreparation();
    savePosition(true);
    readerReady = false;
    $("question-panel").hidden = true;
    $("reader-settings").hidden = true;
    clearSelection();
  }
  route = next;
  document.body.dataset.view = next;
  $("workspace").hidden = next === "reader";
  $("reader").hidden = next !== "reader";
  for (const [id, name] of [
    ["library-view", "library"],
    ["settings-view", "settings"],
  ])
    $(id).hidden = name !== next;
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
    document.title = (next === "settings" ? "设置" : "书库") + " · 页间";
    if (next === "library") renderLibrary();
    if (requested[0] === "imports") openJobs();
    if (next === "settings") {
      renderSettings();
      serviceSettings.show(requested[1]);
      if (requested[1] === "data") dataSettings.show();
    }
  }
}

async function openPalm(id) {
  try {
    const book = books.find((book) => book.id === id);
    if (
      !book ||
      book.type === "pdf" ||
      ["comic", "pre-paginated"].includes(book.layout)
    ) {
      toast("掌上阅读适合可重排的文字书，请先选择小说或 EPUB。", {
        kind: "warning",
      });
      return;
    }
    await savePosition(true);
    if (window.webkit?.messageHandlers?.appNative) {
      window.webkit.messageHandlers.appNative.postMessage({
        action: "palm",
        book: id,
        keys: prefs.palmKeys,
      });
    } else await post("/api/palm", { book: id });
    toast("已打开掌上窗口。");
  } catch (error) {
    toast(error.message, { kind: "error" });
  }
}
function openImport() {
  $("jobs-dialog").close();
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
      toast("暂不支持 " + file.name, { kind: "warning" });
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
  $("import-submit").textContent = "本轮导入结束";
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
  $("book-cloud").hidden = book.type !== "pdf";
  $("book-chapters").hidden = book.type !== "txt";
  $("book-dialog").showModal();
}
async function saveBookOptions(forCloud = false) {
  const patch = {
    title: $("book-name").value.trim() || editingBook.title,
    shelf: $("book-shelf").value,
  };
  if (!forCloud) patch.parseEnabled = $("book-parse").checked;
  if ($("book-offset")?.value !== " " && $("book-offset")?.value)
    patch.pageOffset = Number($("book-offset").value);
  try {
    await savePosition(true);
    await post("/api/books/" + editingBook.id, patch);
    $("book-dialog").close();
    await refreshLibrary();
    if (route === "reader" && current?.id === editingBook.id) {
      location = initialLocation(current);
      renderCurrent(location);
    } else renderLibrary();
    toast("书籍设置已保存。");
    return true;
  } catch (error) {
    $("book-save-note").textContent = error.message;
    return false;
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
  if (
    route === "reader" &&
    current &&
    (previous?.id !== current.id ||
      JSON.stringify(previous?.toc || []) !==
        JSON.stringify(current.toc || []) ||
      ["tocSource", "pageOffset", "processing"].some(
        (key) => previous?.[key] !== current[key],
      ))
  )
    renderToc();
  return data;
}
function validatePreferences(input) {
  const output = { ...defaults, ...input };
  for (const key of ["textMode", "palmMode", "pdfMode"])
    if (!["pages", "scroll"].includes(output[key])) output[key] = defaults[key];
  if (!["arrows", "letters", "off"].includes(output.palmKeys))
    output.palmKeys = defaults.palmKeys;
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
  if (event.isComposing) return;
  const editing =
    event.target.matches?.("input,textarea,select") ||
    event.target.isContentEditable;
  if (event.key === "Escape") {
    if (document.querySelector("dialog[open]")) return;
    if (route === "library") {
      $("library-search").value = "";
      shelfFilter = "all";
      renderLibrary();
    }
    setTocOpen(false);
    $("reader-settings").hidden = true;
    $("question-panel").hidden = true;
    clearSelection();
    if ($("reader").classList.contains("focused")) setFocus(false);
    return;
  }
  if (document.querySelector("dialog[open]")) return;
  if (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    event.key.toLowerCase() === "k"
  ) {
    event.preventDefault();
    if (route === "reader") {
      setTocOpen(true);
      $("toc-tab").click();
      $("toc-search").focus();
    } else if (route === "library") $("library-search").focus();
    else {
      window.addEventListener("hashchange", () => $("library-search").focus(), {
        once: true,
      });
      window.location.hash = "#/library";
    }
    return;
  }
  if (route !== "reader" || editing) return;
  if (event.target.closest?.(".question-panel")) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    bookSearch.open();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "g") {
    event.preventDefault();
    openPageDialog();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && ["[", "]"].includes(event.key)) {
    event.preventDefault();
    const index = location.index + (event.key === "]" ? 1 : -1);
    if (readerReady && index >= 1 && index <= count(current)) navigate(index);
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
    event.preventDefault();
    toggleBookmark();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  // Space must activate the focused control before it can serve as a page shortcut.
  if (
    event.key === " " &&
    event.target.closest?.('button,a,[role="button"],summary')
  )
    return;
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
  const selection = event.target.ownerDocument?.defaultView?.getSelection();
  const inTutor =
    event.target.closest?.(".question-panel") ||
    selection?.anchorNode?.parentElement?.closest(".question-panel");
  if (!inTutor && selection?.rangeCount && !selection.isCollapsed)
    captureSelection(event.target.ownerDocument || document);
  if (
    currentSelection &&
    !inTutor &&
    !event.target.closest?.("input,textarea")
  ) {
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
  const processing = event.target.closest("[data-process]");
  if (processing) {
    documentParsing.open(processing.dataset.process);
    return;
  }
  const reference = event.target.closest("[data-book-reference]");
  if (reference) {
    event.preventDefault();
    bookSearch.open(reference.dataset.bookReference);
    return;
  }
  const retry = event.target.closest("[data-retry]");
  if (retry) {
    retry.disabled = true;
    try {
      await post("/api/books/" + retry.dataset.retry, {
        parseEnabled: true,
        reparse: true,
      });
      await refreshLibrary();
      if (route === "library") renderLibrary();
      toast("已重新开始解析。", { kind: "success" });
    } catch (error) {
      toast(error.message, { kind: "error" });
    } finally {
      retry.disabled = false;
    }
    return;
  }
  const pauseJob = event.target.closest("[data-pause-job]");
  if (pauseJob) {
    documentParsing.pause(pauseJob.dataset.pauseJob);
    return;
  }
  const cloudJob = event.target.closest("[data-cloud]");
  if (cloudJob) {
    const job = jobs.find((job) => job.book === cloudJob.dataset.cloud);
    documentParsing.open(cloudJob.dataset.cloud, job?.pages);
    return;
  }
  const read = event.target.closest("[data-read]");
  if (read) {
    $("jobs-dialog").close();
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
    if (!book || pinning.has(book.id)) return;
    try {
      await setPinned(book.id, !book.onShelf);
    } catch (error) {
      toast(error.message, { kind: "error" });
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
$("empty-action").onclick = () => {
  if ($("empty-action").dataset.emptyAction === "import") openImport();
  else {
    $("library-search").value = "";
    shelfFilter = "all";
    renderLibrary();
    $("library-search").focus();
  }
};
$("jobs-open").onclick = openJobs;
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
$("book-save").onclick = () => saveBookOptions();
$("book-cloud").onclick = async () => {
  const id = editingBook.id;
  if (await saveBookOptions(true)) documentParsing.open(id);
};
$("reader-process").onclick = () => {
  if (current?.type === "pdf") documentParsing.open(current.id);
};
$("reader-home").onclick = () => {
  savePosition(true);
  window.location.hash = "#/library";
};
$("reader-back").onclick = goBack;
$("toc-toggle").onclick = () => {
  setTocOpen($("reader-aside").hidden);
};
$("toc-close").onclick = () => setTocOpen(false);
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
    await removeBookmark(remove.dataset.removeMark);
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
$("book-chapters").onclick = () => {
  const id = editingBook?.id;
  $("book-dialog").close();
  chapterEditor.open(id, current?.id === id ? makePosition() : positions[id]);
};
$("toc-edit").onclick = () => chapterEditor.open(current.id, makePosition());
$("book-export").onclick = () => {
  const id = editingBook?.id;
  $("book-dialog").close();
  bookExport.open(id);
};
$("source-pdf-open").onclick = () => {
  const source = books.find(
    (book) => book.type === "pdf" && book.sourceHash === current.sourcePdfHash,
  );
  if (!source) return;
  const page =
    current.chapters[location.index - 1]?.sourcePdfPage ||
    current.sourcePdfPages?.[0] ||
    1;
  history.push(snapshot());
  savePosition(true);
  current = source;
  readerReady = false;
  if (!palm) window.history.replaceState(null, "", "#/read/" + source.id);
  navigate(page, { pdfY: 0 }, false);
};
$("focus-button").onclick = () =>
  setFocus(!$("reader").classList.contains("focused"));
$("focus-exit").onclick = () => setFocus(false);
$("reader-settings-open").onclick = () =>
  ($("reader-settings").hidden = !$("reader-settings").hidden);
$("reader-settings-close").onclick = () => ($("reader-settings").hidden = true);
$("palm-settings").onclick = () =>
  ($("reader-settings").hidden = !$("reader-settings").hidden);
function openPageDialog() {
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
}
$("page-label").onclick = openPageDialog;
$("page-jump-close").onclick = () => $("page-dialog").close();
$("page-jump-form").onsubmit = (event) => {
  event.preventDefault();
  const page = Number($("page-jump-input").value);
  $("page-dialog").close();
  if (pagination) {
    history.push(snapshot());
    retainedAnchor = null;
    location.fragment = "";
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
watchSelection(document);
$("selection-toolbar").onmousedown = (event) => event.preventDefault();
$("copy-selection").onclick = () =>
  currentSelection && copyText(currentSelection.text);
$("copy-image").onclick = copyImage;
$("chapter-start").onclick = () => {
  if (!currentSelection || current?.type !== "txt") return;
  const selected = currentSelection;
  chapterEditor.open(current.id, selected.position, {
    offset: selected.position.sourceOffset,
    title: selected.text.length <= 40 ? selected.text : "新章节",
    text: selected.text.slice(0, 180),
  });
  clearSelection();
};
$("knowledge-open").onclick = () => bookSearch.open();
$("search-selection").onclick = () => {
  if (currentSelection)
    bookSearch.open(sliceText(currentSelection.text, 0, 6000));
};
function tutorContext(selection = null) {
  if (!current || !readerReady) return null;
  const details = selectionDetails(selection?.position || makePosition());
  const position = details.position;
  let units = [],
    separator = "\n\n",
    unitIndex = 0,
    offset = 0;
  let quote = selection?.text;
  if (current.type === "pdf") {
    const page = pdfPageElement(position.index);
    if (page?._readerBlocks?.length) {
      const entries = page._readerBlocks
        .map((block, order) => ({ text: block.text || "", order }))
        .filter((entry) => entry.text);
      units = entries.map((entry) => entry.text);
      if (selection && position.blockOrder >= 0) {
        unitIndex = entries.findIndex(
          (entry) => entry.order >= position.blockOrder,
        );
        if (unitIndex < 0) unitIndex = entries.length;
        if (entries[unitIndex]?.order === position.blockOrder)
          offset = position.blockOffset || 0;
      }
    } else {
      const layer = page?.querySelector(".textLayer");
      separator = layer?.dataset.ocrEngine === "tesseract-eng" ? "" : " ";
      units =
        layer?.dataset.ocrEngine === "tesseract-eng"
          ? ocrTextUnits(layer)
          : [...(layer?.querySelectorAll("span") || [])]
              .filter(
                (node) =>
                  node.firstChild?.nodeType === 3 && node.textContent.trim(),
              )
              .map((node) => node.textContent);
      if (selection) {
        unitIndex = position._textOrdinal || 0;
        offset = position._textOffset || 0;
      }
    }
    quote ||= sliceText(units.join(separator), 0, 6000);
  } else {
    const elements = readingElements();
    const anchor =
      position.anchor || retainedAnchor || lastAnchor || captureAnchor();
    const target = Number.isSafeInteger(anchor?.sourceNode)
      ? elements.find(
          (element) => Number(element.dataset.sourceNode) === anchor.sourceNode,
        )
      : elements[anchor?.index || 0];
    const leaves = elements.filter(
      (element) =>
        !element.querySelector("p,h1,h2,h3,h4,blockquote,figure,table"),
    );
    unitIndex = Math.max(
      0,
      leaves.findIndex(
        (element) => element === target || target?.contains(element),
      ),
    );
    units = leaves.map((element) => element.textContent.trim());
    const raw = leaves[unitIndex]?.textContent || "";
    const charOffset =
      leaves[unitIndex] === target
        ? Math.max(
            0,
            (anchor?.charOffset || 0) - raw.length + raw.trimStart().length,
          )
        : 0;
    offset =
      selection || (units[unitIndex]?.length || 0) > 6000 ? charOffset : 0;
    quote ||= sliceText(units[unitIndex] || "", offset, offset + 1800);
  }
  quote ||= "";
  unitIndex = Math.min(units.length, unitIndex);
  const context = units.join(separator);
  const cursor = Math.min(
    context.length,
    units
      .slice(0, unitIndex)
      .reduce((sum, unit) => sum + unit.length + separator.length, 0) + offset,
  );
  const start = Math.max(0, cursor - 4000);
  return {
    book: current.id,
    source: {
      quote: sliceText(quote, 0, 6000),
      context: sliceText(context, start, start + 18000),
      contextBefore: sliceText(context, start, cursor),
      position,
      citation: details.source,
      image: selection?.image,
      kind: selection?.kind || "text",
    },
  };
}
const tutor = createTutor({
  api,
  post,
  toast,
  getContext: tutorContext,
  openSource: (book, position) => {
    if (current?.id === book) navigate(position.index, position);
  },
});
$("ask-selection").onclick = () => {
  if (!currentSelection) return;
  const context = tutorContext(currentSelection);
  if (context) tutor.openContext(context);
  $("selection-toolbar").hidden = true;
};
$("ai-open").onclick = tutor.showHistory;
if (palm && native)
  document.querySelector(".ai-settings-link").onclick = (event) => {
    event.preventDefault();
    window.webkit.messageHandlers.readerNative.postMessage({
      action: "settings",
    });
  };
window.addEventListener("app-import", openImport);
window.addEventListener("app-palm", () => openPalm(current?.id));
window.addEventListener("native-file-saved", () =>
  toast("文件已保存。", { kind: "success" }),
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
    if (!restoringPosition) {
      retainedAnchor = null;
      location.fragment = "";
    }
    if (current?.type === "pdf" && prefs.pdfMode === "scroll")
      updatePdfScroll();
    lastAnchor = retainedAnchor || captureAnchor();
    updateProgress();
    refreshSelectionToolbar();
    clearTimeout(saveTimer);
    if (!restoringPosition)
      saveTimer = setTimeout(() => savePosition().catch(() => {}), 250);
  },
  { passive: true },
);
window.addEventListener("palm-resume", async () => {
  const state = await api("/api/state");
  positions = state.positions || positions;
  prefs = validatePreferences(state.prefs || {});
  renderSettings();
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
  if (pdfWarmStamp !== null)
    navigator.sendBeacon(
      "/api/pdf/prepare",
      JSON.stringify({ action: "leave", client: writer }),
    );
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

async function poll(resume = false) {
  try {
    const version = await api("/api/library-version");
    if (version.revision !== libraryRevision) {
      libraryRevision = version.revision;
      const previousFlag = current?.parseEnabled,
        previousEnhancement = current?.enhancementRevision,
        previousStructure = current?.structureRevision,
        previousCount = current?.chapters?.length;
      await refreshLibrary();
      if (route === "library") renderLibrary();
      if (
        route === "reader" &&
        current &&
        (previousFlag !== current.parseEnabled ||
          previousEnhancement !== current.enhancementRevision ||
          previousStructure !== current.structureRevision ||
          (current.type === "txt" && previousCount !== current.chapters.length))
      ) {
        if (current.type === "pdf") {
          for (const key of ocrCache.keys())
            if (key.startsWith(current.id + ":")) ocrCache.delete(key);
          if (previousFlag !== current.parseEnabled)
            await renderCurrent(makePosition());
          else refreshPdfEnhancements();
        } else {
          if (current.type === "txt") current.loaded = false;
          location = initialLocation(current);
          renderCurrent(location);
        }
      }
    }
    const state = await api("/api/state");
    if (stateWrites || state.revision < stateRevision) return;
    const remote = current && state.positions?.[current.id];
    const followingBook = current?.id;
    const follow = shouldFollowPosition({
      revision: state.revision,
      seen: stateRevision,
      remote,
      local: location,
      allowed:
        route === "reader" &&
        readerReady &&
        !currentSelection &&
        !document.activeElement?.matches("input,textarea,select") &&
        (resume || Date.now() - lastInput > 1000),
    });
    const nextPrefs = validatePreferences(state.prefs || {});
    const preferencesChanged =
      JSON.stringify(prefs) !== JSON.stringify(nextPrefs);
    const marksChanged =
      JSON.stringify(bookmarks) !== JSON.stringify(state.bookmarks || []);
    const positionsChanged =
      JSON.stringify(positions) !== JSON.stringify(state.positions || {});
    if (
      state.revision === stateRevision &&
      !follow &&
      !preferencesChanged &&
      !marksChanged &&
      !positionsChanged
    )
      return;
    stateRevision = state.revision;
    positions = state.positions || positions;
    bookmarks = state.bookmarks || bookmarks;
    if (preferencesChanged) {
      const previousPrefs = prefs;
      prefs = nextPrefs;
      const onlyKeysChanged = Object.keys(prefs).every(
        (key) => key === "palmKeys" || prefs[key] === previousPrefs[key],
      );
      const anchor = lastAnchor || captureAnchor();
      applyPreferences();
      renderSettings();
      if (route === "reader" && current) {
        if (!onlyKeysChanged && current.type === "pdf") {
          if (
            previousPrefs.pdfMode !== prefs.pdfMode ||
            previousPrefs.pdfZoom !== prefs.pdfZoom
          )
            await renderCurrent(makePosition());
        } else if (!onlyKeysChanged) {
          if (current.type === "epub") await styleEpub();
          configureTextLayout();
          restorePosition(() => restoreAnchor(anchor));
          updateProgress();
        }
        reportNative();
      }
    }
    if (route === "library" && (preferencesChanged || positionsChanged))
      renderLibrary();
    if (marksChanged) renderBookmarks();
    if (
      follow &&
      current?.id === followingBook &&
      route === "reader" &&
      remote.updatedAt > (location?.updatedAt || 0)
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
  window.webkit?.messageHandlers?.appNative?.postMessage({ action: "ready" });
  setInterval(updateTimer, 1000);
  setInterval(poll, 1800);
  window.addEventListener("focus", () => poll(true));
  window.addEventListener("blur", () => savePosition(true).catch(() => {}));
} catch (error) {
  $("startup").textContent = window.webkit?.messageHandlers?.appNative
    ? "暂时无法打开书库。请重新打开页间，已保存的资料会保留。 " + error.message
    : "新版需要本地阅读服务。请双击 start.command 启动，再刷新页面。 " +
      error.message;
  console.error(error);
}
