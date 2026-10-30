import { escapeHTML } from "./shared.mjs";
import { prepareQuestionImage } from "./book-images.mjs";

export function enablePanelDragging(panel, handle) {
  let start;
  const place = (left, top) => {
    const rectangle = panel.getBoundingClientRect();
    Object.assign(panel.style, {
      left: `${Math.max(8, Math.min(innerWidth - rectangle.width - 8, left))}px`,
      top: `${Math.max(8, Math.min(innerHeight - rectangle.height - 8, top))}px`,
      right: "auto",
      bottom: "auto",
    });
  };
  handle.addEventListener("pointerdown", (event) => {
    if (
      event.button !== 0 ||
      event.target.closest("button,a,input,textarea,select,summary")
    )
      return;
    const rectangle = panel.getBoundingClientRect();
    start = {
      x: event.clientX,
      y: event.clientY,
      left: rectangle.left,
      top: rectangle.top,
    };
    handle.setPointerCapture(event.pointerId);
    panel.dataset.dragging = "true";
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (start)
      place(
        start.left + event.clientX - start.x,
        start.top + event.clientY - start.y,
      );
  });
  const stop = () => {
    start = null;
    delete panel.dataset.dragging;
  };
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
  handle.addEventListener("lostpointercapture", stop);
  handle.addEventListener("keydown", (event) => {
    if (event.target.id !== "question-drag") return;
    const delta = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    const rectangle = panel.getBoundingClientRect(),
      step = event.shiftKey ? 32 : 8;
    place(rectangle.left + delta[0] * step, rectangle.top + delta[1] * step);
  });
  const constrain = () => {
    if (panel.hidden || !panel.style.left) return;
    const rectangle = panel.getBoundingClientRect();
    place(rectangle.left, rectangle.top);
  };
  window.addEventListener("resize", constrain);
  new ResizeObserver(constrain).observe(panel);
}

export function createTutor({
  api,
  post,
  toast,
  getContext,
  openSource,
  openWindow,
  closeWindow,
  detached = false,
}) {
  const $ = (id) => document.getElementById(id);
  if (!detached)
    enablePanelDragging(
      $("question-panel"),
      $("question-panel").querySelector(".aside-head"),
    );
  let book,
    source,
    active,
    pending = false,
    revision = 0,
    historyMode = false,
    supportsImages = false,
    pollTimer,
    quoteKey,
    quoteRevision = 0;
  const url = (id) =>
    "/api/ai/conversations?book=" +
    encodeURIComponent(book) +
    (id ? "&id=" + encodeURIComponent(id) : "");

  function showConversation() {
    clearTimeout(pollTimer);
    historyMode = false;
    $("ai-history-list").hidden = true;
    $("ai-conversation").hidden = false;
    $("ai-history-toggle").textContent = "本书记录";
    const original = active?.source || source;
    $("question-source").textContent = original
      ? "[1] " + original.citation + " · 返回原文"
      : "";
    showQuote(original);
    $("ai-quote").hidden =
      !!original?.image && /^\[完整图(?:像|表)\]$/.test(original.quote || "");
    $("question-source").disabled = !original;
    $("question-image").hidden = !original?.image;
    if (original?.image) $("question-image").src = original.image;
    else $("question-image").removeAttribute("src");
    $("ai-messages").innerHTML =
      (active?.storageWarning
        ? `<p class="ai-error" role="alert">${escapeHTML(active.storageWarning)}</p>`
        : "") +
      (active?.messages || [])
        .map((message, index) => {
          if (message.role === "user")
            return `<article class="ai-message ai-user" aria-label="提问">${message.imageAttached ? '<small>已附原图</small>' : ""}<div>${escapeHTML(message.content)}</div></article>`;
          if (message.status === "generating")
            return `<article class="ai-message" aria-label="回答">${references(message, index)}<div class="ai-stream">${escapeHTML(message.content || "生成中…")}</div></article>`;
          if (message.status === "error" || message.status === "stopped")
            return `<article class="ai-message ai-error"><small>${message.status === "stopped" ? "已停止" : "本次未完成"}</small><p>${escapeHTML(message.error)}</p><div class="ai-answer">${message.html || escapeHTML(message.content)}</div>${references(message, index)}${index === active.messages.length - 1 ? '<button class="secondary-button" data-ai-retry>重新生成</button>' : ""}</article>`;
          return `<article class="ai-message" aria-label="回答"><div class="ai-answer">${message.html || escapeHTML(message.content)}</div>${references(message, index)}</article>`;
        })
        .join("");
    $("ai-submit").disabled =
      pending || active?.messages.at(-1)?.status === "generating";
    $("ai-submit").textContent = pending
      ? "生成中…"
      : active
        ? "继续提问"
        : "发送提问";
    const generating = active?.messages.at(-1)?.status === "generating";
    $("ai-stop").hidden = !generating;
    $("ai-progress").hidden = !pending && !generating;
    imageControls();
    if (
      active?.messages.at(-1)?.status === "generating" &&
      !$("question-panel").hidden
    )
      pollAnswer();
  }
  async function showQuote(original) {
    const key = JSON.stringify([book, original?.quote, original?.position]);
    if (key === quoteKey) return;
    quoteKey = key;
    const version = ++quoteRevision,
      quote = original?.quote || "",
      element = $("ai-quote");
    element.textContent = quote ? "正在整理选段…" : "";
    if (!quote) {
      element.removeAttribute("aria-busy");
      return;
    }
    element.setAttribute("aria-busy", "true");
    try {
      const data = await post("/api/ai/preview", {
        book,
        quote,
        position: original.position,
      });
      if (version === quoteRevision) element.innerHTML = data.html;
    } catch {
      if (version === quoteRevision) element.textContent = quote;
    } finally {
      if (version === quoteRevision) element.removeAttribute("aria-busy");
    }
  }
  function imageControls() {
    const original = active?.source || source;
    $("ai-image-option").hidden = !original?.image;
    $("ai-image-status").hidden = !original?.image || supportsImages;
    $("ai-send-image").disabled =
      !supportsImages ||
      pending ||
      active?.messages.at(-1)?.status === "generating";
    $("ai-image-status").textContent = !supportsImages
      ? "当前模型不支持图像。"
      : $("ai-send-image").checked
        ? "附带原图。"
        : "仅发送文字。";
  }
  function references(message, messageIndex) {
    const status = message.indexStatus;
    return (
      (message.citationWarning
        ? `<p class="ai-citation-warning">${escapeHTML(message.citationWarning)}</p>`
        : "") +
      (message.nearbyText
        ? `<details class="ai-nearby"><summary>[2] 本次附近文字</summary><p>${escapeHTML(message.nearbyText)}</p></details>`
        : "") +
      (message.indexWarning
        ? `<p class="setting-note">${escapeHTML(message.indexWarning)}</p>`
        : status?.partial
          ? `<p class="setting-note">仅覆盖 ${status.covered} / ${status.total} ${escapeHTML(status.unit)}</p>`
          : "") +
      (message.references || [])
        .map(
          (source, index) =>
            `<button class="ai-reference" data-ai-reference="${messageIndex}:${index}" title="预览并前往来源">[${source.number}] ${escapeHTML(source.label || source.citation)}</button>`,
        )
        .join("")
    );
  }
  function pollAnswer() {
    const version = revision,
      ident = active.id;
    pollTimer = setTimeout(async () => {
      if (version !== revision || $("question-panel").hidden || historyMode)
        return;
      try {
        const data = await api(url(ident));
        if (version !== revision) return;
        active = data.conversation;
        showConversation();
      } catch {
        if (version === revision) pollAnswer();
      }
    }, 600);
  }
  async function configuration() {
    try {
      const config = await api("/api/ai/status");
      supportsImages = !!config.supportsImages;
      if (!supportsImages) $("ai-send-image").checked = false;
      imageControls();
      $("ai-model-status").textContent = config.configured
        ? ""
        : config.message;
      document.querySelector(".ai-settings-link").title = config.configured
        ? config.host + " · " + config.model
        : "模型设置";
    } catch {
      $("ai-model-status").textContent = "暂时无法检查模型配置。";
    }
  }
  function openContext(context) {
    if (openWindow) return openWindow({ context, history: false });
    revision++;
    book = context.book;
    $("question-panel").dataset.book = book;
    source = context.source;
    active = null;
    $("ai-send-image").checked = source.kind === "image";
    $("question-panel").hidden = false;
    $("question-input").value = "";
    configuration();
    showConversation();
    $("question-input").focus();
  }
  async function showHistory() {
    const context = getContext();
    if (!context) return;
    if (openWindow) return openWindow({ context, history: true });
    book = context.book;
    $("question-panel").dataset.book = book;
    revision++;
    const version = revision;
    historyMode = true;
    $("question-panel").hidden = false;
    $("ai-conversation").hidden = true;
    $("ai-history-list").hidden = false;
    $("ai-history-toggle").textContent = "围绕当前页";
    $("ai-history-list").textContent = "正在读取本书记录…";
    configuration();
    try {
      const data = await api(url());
      if (version !== revision) return;
      $("ai-history-list").innerHTML = data.conversations.length
        ? data.conversations
            .map(
              (item) =>
                `<button class="ai-history-item" data-ai-conversation="${escapeHTML(item.id)}"><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(item.citation)}</span>${["generating", "error", "stopped"].includes(item.status) ? `<small>${item.status === "generating" ? "生成中" : item.status === "error" ? "未完成" : "已停止"}</small>` : ""}</button>`,
            )
            .join("")
        : '<div class="empty-state">暂无对话</div>';
    } catch (error) {
      $("ai-history-list").textContent = error.message;
    }
  }
  async function loadConversation(id) {
    const version = ++revision;
    try {
      const data = await api(url(id));
      if (version !== revision) return;
      active = data.conversation;
      source = null;
      $("ai-send-image").checked = !!active.messages
        .filter((message) => message.role === "user")
        .at(-1)?.imageAttached;
      $("question-input").value = "";
      showConversation();
    } catch (error) {
      toast(error.message, { kind: "error" });
    }
  }
  async function send(retry = false) {
    if (pending) return;
    const question = retry
      ? active?.messages.at(-2)?.content
      : $("question-input").value.trim();
    if (!question) {
      $("question-input").focus();
      return;
    }
    const startingRevision = revision;
    const config = await api("/api/ai/status");
    if (pending || startingRevision !== revision) return;
    if (!config.configured) {
      await configuration();
      toast(config.message, { kind: "warning" });
      return;
    }
    const original = active?.source || source;
    const sendImage =
      !!original?.image &&
      $("ai-send-image").checked &&
      !!config.supportsImages;
    if (
      !active &&
      (!source?.quote || /^\[.*图.*\]$/.test(source.quote)) &&
      !sendImage
    ) {
      toast(
        config.supportsImages
          ? "请勾选附带原图，或重新选择文字提问。"
          : "当前选取只有原图，请在模型设置中启用支持图像的模型。",
        {
          kind: "warning",
        },
      );
      return;
    }
    const version = revision,
      sendingBook = book,
      conversation = active?.id,
      outgoing = !active && source ? { ...source } : undefined,
      previousKnowledge = $("ai-previous-knowledge").checked;
    pending = true;
    showConversation();
    $("ai-progress").textContent =
      "回答逐段显示，可停止或继续阅读；内容与引用保存在本书记录中。";
    try {
      if (outgoing) {
        if (sendImage)
          outgoing.image = await prepareQuestionImage(
            outgoing.image,
            sendingBook,
          );
        else delete outgoing.image;
      }
      const data = await post("/api/ai/start", {
        book: sendingBook,
        conversation,
        source: outgoing,
        question,
        retry,
        previousKnowledge,
        sendImage,
      });
      if (
        sendingBook === book &&
        (version === revision || active?.id === data.conversation.id)
      ) {
        active = data.conversation;
        $("question-input").value = "";
        if (!historyMode) showConversation();
      }
    } catch (error) {
      if (sendingBook === book && error.data?.conversation)
        await loadConversation(error.data.conversation);
      toast(error.message, { kind: "error" });
    } finally {
      pending = false;
      if (!historyMode) showConversation();
      else showHistory();
    }
  }

  $("ai-question-form").onsubmit = (event) => {
    event.preventDefault();
    send().catch((error) => toast(error.message, { kind: "error" }));
  };
  $("ai-send-image").onchange = imageControls;
  $("question-input").onkeydown = (event) => {
    if (
      !event.isComposing &&
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault();
      $("ai-question-form").requestSubmit();
    }
  };
  $("ai-messages").onclick = (event) => {
    if (event.target.closest("[data-ai-retry]"))
      send(true).catch((error) => toast(error.message, { kind: "error" }));
    const button = event.target.closest("[data-ai-reference]");
    if (button) {
      const [message, index] = button.dataset.aiReference
        .split(":")
        .map(Number);
      const source = active?.messages[message]?.references?.[index];
      if (!source) return;
      let preview = button.nextElementSibling;
      if (preview?.classList.contains("ai-reference-preview")) {
        preview.remove();
        return;
      }
      preview = document.createElement("div");
      preview.className = "ai-reference-preview";
      const text = document.createElement("p");
      text.textContent = source.text;
      const jump = document.createElement("button");
      jump.className = "secondary-button";
      jump.textContent = "前往原文";
      jump.onclick = () => {
        if (!detached) $("question-panel").hidden = true;
        openSource(book, source.position);
      };
      preview.append(text, jump);
      button.after(preview);
    }
  };
  $("ai-stop").onclick = async () => {
    if (!active) return;
    const ident = active.id,
      version = revision;
    $("ai-stop").disabled = true;
    try {
      const data = await post("/api/ai/cancel", { book, conversation: ident });
      if (version === revision && active?.id === ident) {
        active = data.conversation;
        showConversation();
      }
    } catch (error) {
      toast(error.message, { kind: "error" });
    } finally {
      $("ai-stop").disabled = false;
    }
  };
  $("ai-history-list").onclick = (event) => {
    const button = event.target.closest("[data-ai-conversation]");
    if (button) loadConversation(button.dataset.aiConversation);
  };
  $("ai-history-toggle").onclick = () => {
    if (historyMode) {
      const context = getContext();
      if (context?.source.quote) openContext(context);
      else toast("当前页文字尚未就绪，请先选中原文。", { kind: "warning" });
    } else showHistory();
  };
  $("question-source").onclick = () => {
    const original = active?.source || source;
    if (!original) return;
    if (!detached) $("question-panel").hidden = true;
    openSource(book, original.position);
  };
  $("question-close").onclick = () => {
    $("question-panel").hidden = true;
    clearTimeout(pollTimer);
    closeWindow?.();
  };
  $("copy-question").onclick = async () => {
    const original = active?.source || source;
    if (!original) return;
    const text = [
      original.citation,
      original.quote,
      ...(active?.messages || [])
        .filter((message) => message.content)
        .map(
          (message) =>
            (message.role === "user" ? "问题：" : "回答：") +
            message.content +
            (message.citationWarning ? "\n" + message.citationWarning : ""),
        ),
      $("question-input").value,
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      toast("出处与对话已复制。", { kind: "success" });
    } catch {
      toast("暂时无法复制，请手动选择需要的文字。", { kind: "warning" });
    }
  };
  function resume() {
    $("question-panel").hidden = false;
    configuration();
    if (historyMode) showHistory();
    else showConversation();
  }
  return { openContext, showHistory, resume };
}
