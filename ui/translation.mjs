import { escapeHTML, icon } from "./shared.mjs";
import { enablePanelDragging } from "./tutor.mjs";

export const languages = {
  auto: "自动识别",
  zh: "简体中文",
  en: "英语",
  ja: "日语",
  ko: "韩语",
  fr: "法语",
  de: "德语",
  es: "西班牙语",
  ru: "俄语",
  it: "意大利语",
  pt: "葡萄牙语",
};

export function createTranslation({
  api,
  post,
  toast,
  openWindow,
  closeWindow,
  setPinned,
  openSource,
  ask,
  settings,
  detached = false,
}) {
  const $ = (id) => document.getElementById(id),
    panel = $("translation-panel");
  let context,
    result,
    active,
    revision = 0,
    timer,
    pinned = false,
    historyRevision = 0,
    previewRevision = 0,
    editingOriginal = false,
    aiReady = true;
  for (const id of ["translation-from", "translation-to"])
    $(id).innerHTML = Object.entries(languages)
      .map(
        ([value, label]) =>
          `<option value="${value}">${value === "auto" && id.endsWith("to") ? "中英互译" : label}</option>`,
      )
      .join("");
  if (!detached) enablePanelDragging(panel, $("translation-drag"));
  panel
    .querySelectorAll("[data-icon]")
    .forEach((node) => (node.innerHTML = icon(node.dataset.icon)));

  const message = (text) => ($("translation-status").textContent = text);
  const showContent = () => {
    $("translation-content").hidden = false;
    $("translation-history").hidden = true;
    historyRevision++;
  };
  const cancelJob = (job) =>
    post("/api/translation/cancel", { book: job.book, id: job.id }).catch(
      () => {},
    );
  function stop() {
    revision++;
    clearTimeout(timer);
    if (active) cancelJob(active);
    active = null;
    $("translation-stop").hidden = true;
    const unavailable = $("translation-provider").value === "ai" && !aiReady;
    $("translation-submit").disabled = unavailable;
    $("translation-retry").disabled = unavailable;
    panel.removeAttribute("aria-busy");
  }
  function close() {
    stop();
    historyRevision++;
    panel.hidden = true;
    closeWindow?.();
  }
  function pin(value) {
    pinned = value;
    $("translation-pin").setAttribute("aria-pressed", String(value));
    $("translation-pin").title = value ? "取消固定 (⌘P)" : "固定窗口 (⌘P)";
    setPinned?.(value);
  }
  function availability() {
    const unavailable = $("translation-provider").value === "ai" && !aiReady;
    $("translation-submit").disabled = unavailable || !!active;
    $("translation-retry").disabled = unavailable || !!active;
    if (unavailable) {
      message("AI 尚未配置。");
      $("translation-settings").hidden = false;
    }
  }
  function setEditing(value) {
    editingOriginal = value;
    $("translation-query").hidden = !value;
    $("translation-original-preview").hidden = value;
    $("translation-edit").innerHTML = icon(value ? "check" : "edit");
    $("translation-edit").title = value ? "完成编辑" : "编辑原文";
    $("translation-edit").setAttribute(
      "aria-label",
      value ? "完成编辑" : "编辑原文",
    );
    $("translation-submit").hidden = !value;
    $("translation-edit").setAttribute("aria-expanded", String(value));
  }
  async function renderOriginal() {
    const version = ++previewRevision;
    const text = $("translation-query").value;
    $("translation-original-preview").textContent = text;
    if (!context?.source || !text.trim()) return;
    try {
      const data = await post("/api/translation/preview", { ...context, text });
      if (version === previewRevision && !panel.hidden)
        $("translation-original-preview").innerHTML = data.html;
    } catch {
      /* Keep readable plain text when a preview is unavailable. */
    }
  }
  function showResult(item) {
    result = item;
    if (item.provider) $("translation-provider").value = item.provider;
    availability();
    $("translation-result").hidden = false;
    $("translation-output").innerHTML = item.html;
    $("translation-explanation").innerHTML = item.explanationHtml || "";
    $("translation-star").setAttribute("aria-pressed", String(item.favorite));
    $("translation-star").disabled = !!item.storageWarning;
    $("translation-detected").textContent =
      languages[item.detectedLanguage] || "";
    $("translation-detected").hidden = !languages[item.detectedLanguage];
    $("translation-provider").title = item.model || "";
    $("translation-star").innerHTML =
      `${item.favorite ? "取消收藏" : "收藏"}<kbd>⌘S</kbd>`;
    message(item.storageWarning || "");
  }

  async function translate(force = false) {
    if (!context?.source) return;
    stop();
    showContent();
    if ($("translation-provider").value === "ai" && !aiReady) {
      availability();
      return;
    }
    setEditing(false);
    renderOriginal();
    const current = revision,
      request = structuredClone(context);
    const text = $("translation-query").value;
    if (!text.trim()) {
      message("请填写需要翻译的原文。");
      return;
    }
    result = null;
    $("translation-result").hidden = true;
    $("translation-settings").hidden = true;
    $("translation-stop").hidden = false;
    $("translation-submit").disabled = true;
    $("translation-retry").disabled = true;
    panel.setAttribute("aria-busy", "true");
    message("正在翻译…");
    const fail = (error) => {
      if (current !== revision) return;
      active = null;
      $("translation-stop").hidden = true;
      $("translation-submit").disabled = false;
      $("translation-retry").disabled = false;
      panel.removeAttribute("aria-busy");
      message(error.message || "翻译没有完成，请重试。");
      $("translation-settings").hidden = false;
    };
    try {
      const job = await post("/api/translation/start", {
        ...request,
        text,
        force,
        provider: $("translation-provider").value,
        sourceLanguage: $("translation-from").value,
        targetLanguage: $("translation-to").value,
      });
      if (current !== revision) {
        if (job.status === "running") cancelJob(job);
        return;
      }
      active = job;
      const receive = (value) => {
        if (current !== revision) return;
        if (value.status === "running") {
          timer = setTimeout(poll, 350);
          return;
        }
        active = null;
        $("translation-stop").hidden = true;
        $("translation-submit").disabled = false;
        $("translation-retry").disabled = false;
        panel.removeAttribute("aria-busy");
        if (value.status === "ready") showResult(value.result);
        else message(value.error || "已停止翻译。");
      };
      const poll = async () => {
        try {
          receive(
            await api(
              `/api/translation/task?book=${encodeURIComponent(job.book)}&id=${job.id}`,
            ),
          );
        } catch (error) {
          fail(error);
        }
      };
      receive(job);
    } catch (error) {
      fail(error);
    }
  }
  function showSource() {
    $("translation-source").hidden = !context?.source;
    $("translation-source").textContent = "返回原文";
    $("translation-source").title = context?.source?.citation || "";
  }
  function position(rect) {
    if (pinned && panel.style.left) return;
    const box = rect || { left: (innerWidth - 400) / 2, bottom: 100 };
    Object.assign(panel.style, {
      left:
        Math.max(8, Math.min(innerWidth - panel.offsetWidth - 8, box.left)) +
        "px",
      top:
        Math.max(
          8,
          Math.min(
            innerHeight - Math.min(panel.offsetHeight, innerHeight - 16) - 8,
            box.bottom + 8,
          ),
        ) + "px",
      right: "auto",
      bottom: "auto",
    });
  }
  async function open(request, rect, history = false) {
    if (!request?.book) return;
    if (openWindow) {
      openWindow({ context: request, rect, history });
      return;
    }
    stop();
    context = structuredClone(request);
    result = null;
    message("");
    panel.hidden = false;
    if (!detached) {
      panel.tabIndex = -1;
      panel.focus({ preventScroll: true });
    }
    showContent();
    showSource();
    $("translation-query").value = context.source?.quote || "";
    setEditing(false);
    renderOriginal();
    $("translation-result").hidden = true;
    $("translation-settings").hidden = true;
    if (!detached) position(rect);
    const version = revision;
    try {
      const status = await api("/api/translation/status");
      if (version !== revision || panel.hidden) return;
      aiReady = status.aiReady;
      $("translation-provider").value = status.provider;
      $("translation-provider").querySelector('[value="ai"]').disabled =
        !aiReady;
    } catch (error) {
      message(error.message);
    }
    if (version !== revision || panel.hidden) return;
    availability();
    if (history) await showHistory();
    else await translate();
  }
  async function showHistory() {
    if (!context?.book) return;
    stop();
    $("translation-content").hidden = true;
    $("translation-history").hidden = false;
    const version = ++historyRevision,
      book = context.book;
    $("translation-history-items").textContent = "正在读取…";
    try {
      const data = await api(
        "/api/translation/history?book=" + encodeURIComponent(book),
      );
      if (version !== historyRevision || panel.hidden) return;
      const items = data.items.filter(
        (row) => !$("translation-only-favorites").checked || row.favorite,
      );
      $("translation-history-items").innerHTML = items.length
        ? items
            .map(
              (item, index) =>
                `<button class="translation-history-item" data-translation="${index}"><span>${item.favorite ? "★ " : ""}${escapeHTML(item.text)}</span><small>${escapeHTML(item.translation)}</small></button>`,
            )
            .join("")
        : '<p class="setting-note">暂无翻译记录</p>';
      $("translation-history-items")
        .querySelectorAll("[data-translation]")
        .forEach(
          (button) =>
            (button.onclick = async () => {
              const item = items[Number(button.dataset.translation)];
              context = { book, source: item.source };
              $("translation-query").value = item.text;
              $("translation-from").value = item.sourceLanguage;
              $("translation-to").value = item.targetLanguage;
              const current = ++historyRevision;
              try {
                const saved = await api(
                  `/api/translation/item?book=${encodeURIComponent(book)}&id=${item.id}`,
                );
                if (current !== historyRevision || panel.hidden) return;
                showContent();
                showSource();
                setEditing(false);
                renderOriginal();
                showResult(saved);
              } catch (error) {
                toast(error.message, { kind: "warning" });
              }
            }),
        );
    } catch (error) {
      if (version === historyRevision)
        $("translation-history-items").textContent = error.message;
    }
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制。", { kind: "success" });
    } catch {
      toast("无法复制，请选中文字后使用系统复制。", { kind: "warning" });
    }
  }
  $("translation-form").onsubmit = (event) => {
    event.preventDefault();
    translate(Boolean(result));
  };
  $("translation-query").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      translate(Boolean(result));
    }
  });
  $("translation-query").addEventListener("input", () => {
    stop();
    previewRevision++;
    result = null;
    $("translation-result").hidden = true;
    message("");
  });
  $("translation-edit").onclick = () => {
    setEditing(!editingOriginal);
    if (editingOriginal) $("translation-query").focus();
    else renderOriginal();
  };
  $("translation-provider").onchange = () => {
    availability();
    if (context?.source) translate();
  };
  $("translation-retry").onclick = () => translate(true);
  $("translation-close").onclick = close;
  $("translation-pin").onclick = () => pin(!pinned);
  $("translation-stop").onclick = () => {
    stop();
    message("已停止翻译。");
  };
  $("translation-recent").onclick = showHistory;
  $("translation-only-favorites").onchange = showHistory;
  $("translation-back").onclick = showContent;
  $("translation-from").onchange = $("translation-to").onchange = () => {
    if (context?.source) translate();
  };
  $("translation-swap").onclick = () => {
    const from = $("translation-from").value,
      to = $("translation-to").value;
    if (!result) {
      message("先完成翻译，再交换语言。");
      return;
    }
    $("translation-query").value = result.translation;
    setEditing(false);
    renderOriginal();
    $("translation-from").value =
      to === "auto" ? (result.detectedLanguage === "zh" ? "en" : "zh") : to;
    $("translation-to").value =
      from === "auto" && result.detectedLanguage in languages
        ? result.detectedLanguage
        : from;
    translate();
  };
  $("translation-copy-original").onclick = () =>
    copy($("translation-query").value);
  $("translation-copy").onclick = () => {
    if (result) copy(result.translation);
  };
  $("translation-source").onclick = () => {
    if (context?.source) {
      openSource?.(context.book, context.source.position);
      if (!pinned) close();
    }
  };
  $("translation-ask").onclick = () => {
    if (context?.source) {
      ask?.(structuredClone(context));
      if (!pinned) close();
    }
  };
  $("translation-star").onclick = async () => {
    if (!result) return;
    const previous = result;
    try {
      const item = await post("/api/translation/favorite", {
        book: context.book,
        id: previous.id,
        favorite: !previous.favorite,
      });
      if (result?.id === item.id) {
        result.favorite = item.favorite;
        $("translation-star").setAttribute(
          "aria-pressed",
          String(item.favorite),
        );
        $("translation-star").innerHTML =
          `${item.favorite ? "取消收藏" : "收藏"}<kbd>⌘S</kbd>`;
      }
    } catch (error) {
      toast(error.message, { kind: "warning" });
    }
  };
  panel.addEventListener("click", (event) => {
    if (
      !event.target.closest("#translation-menu") ||
      event.target.closest(
        ".translation-menu-items button,.translation-menu-items a",
      )
    )
      $("translation-menu").open = false;
  });
  $("translation-settings-menu").onclick = (event) => {
    if (settings) {
      event.preventDefault();
      settings();
    }
    if (!pinned) close();
  };
  $("translation-settings").onclick = (event) => {
    if (settings) {
      event.preventDefault();
      settings();
    }
    if (!pinned) close();
  };
  async function refresh() {
    if (panel.hidden) return;
    const version = revision;
    try {
      const status = await api("/api/translation/status");
      if (version !== revision || panel.hidden) return;
      aiReady = status.aiReady;
      $("translation-provider").querySelector('[value="ai"]').disabled =
        !aiReady;
      availability();
    } catch {
      /* Current result remains readable when settings cannot refresh. */
    }
  }
  (detached ? document : panel).addEventListener("keydown", (event) => {
    if (panel.hidden) return;
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      const editing =
        event.target.matches?.("input,textarea,select") ||
        event.target.isContentEditable;
      const selection = window.getSelection();
      const selectedHere =
        selection &&
        !selection.isCollapsed &&
        panel.contains(selection.anchorNode);
      if (key === "c" && !editing && !selectedHere && result) {
        event.preventDefault();
        event.stopPropagation();
        copy(result.translation);
        return;
      }
      if (key === "a" && event.shiftKey && !editing && context?.source) {
        event.preventDefault();
        event.stopPropagation();
        $("translation-ask").click();
        return;
      }
      if (["p", "r", "s"].includes(key)) {
        event.preventDefault();
        event.stopPropagation();
        if (key === "p") pin(!pinned);
        if (key === "r") translate(true);
        if (key === "s" && result) $("translation-star").click();
      }
    }
  });
  if (!detached) {
    document.addEventListener("pointerdown", (event) => {
      if (
        !pinned &&
        !panel.hidden &&
        !event.target.closest(
          ".translation-panel,.selection-toolbar,#translation-history-open",
        )
      )
        close();
    });
    window.addEventListener("blur", () => {
      if (!pinned) close();
    });
  }
  return {
    open,
    close,
    refresh,
    dismiss: () => {
      stop();
      panel.hidden = true;
    },
    isOpen: () => !panel.hidden,
  };
}
