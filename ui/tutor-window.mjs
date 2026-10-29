import { createTutor } from "./tutor.mjs";
import { createToasts } from "./feedback.mjs";
import { icon } from "./shared.mjs";

const $ = (id) => document.getElementById(id);
const bridge = window.webkit?.messageHandlers?.tutorNative;
document.body.dataset.mode = "tutor";
document.body.dataset.readerBuild = "2.48";
document.title = "书内答疑 · 页间";
document
  .querySelectorAll("[data-icon]")
  .forEach((node) => (node.innerHTML = icon(node.dataset.icon)));
$("question-drag").removeAttribute("tabindex");
$("question-drag").removeAttribute("title");
$("question-drag").removeAttribute("aria-label");
const toast = createToasts($("toasts"));
async function api(path, options) {
  const response = await fetch(path, options),
    data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "操作没有完成，请重试。");
    error.data = data;
    throw error;
  }
  return data;
}
const post = (path, body) =>
  api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
let context, lastSelection;
const tutor = createTutor({
  api,
  post,
  toast,
  detached: true,
  getContext: () => context,
  openSource: (book, position) =>
    bridge?.postMessage({ action: "source", book, position }),
  closeWindow: () => bridge?.postMessage({ action: "close" }),
});
window.readerTutorReceive = (request) => {
  if (!request?.context?.book || !request.context.source) return;
  context = request.context;
  const key = JSON.stringify(context, (_, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
        )
      : value,
  );
  if (request.history) {
    tutor.showHistory();
    lastSelection = undefined;
  } else {
    if (lastSelection === key) tutor.resume();
    else tutor.openContext(context);
    lastSelection = key;
  }
};
$("question-panel").hidden = false;
$("ai-conversation").hidden = true;
$("ai-model-status").textContent = "请在阅读窗口选中内容提问。";
document.querySelector(".ai-settings-link").onclick = (event) => {
  if (!bridge) return;
  event.preventDefault();
  bridge.postMessage({ action: "settings" });
};
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") $("question-close").click();
});
const updateTheme = () =>
  api("/api/state")
    .then((state) => {
      const theme = state.prefs?.theme;
      if (["paper", "sage", "blue", "night"].includes(theme))
        document.body.dataset.theme = theme;
    })
    .catch(() => {});
updateTheme();
window.addEventListener("focus", () => {
  updateTheme();
  if (context) tutor.resume();
});
bridge?.postMessage({ action: "ready" });
