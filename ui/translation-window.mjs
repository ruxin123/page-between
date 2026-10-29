import { createTranslation } from "./translation.mjs";
import { createToasts } from "./feedback.mjs";
const bridge = window.webkit?.messageHandlers?.translationNative;
document.body.dataset.mode = "translation";
document.body.dataset.readerBuild = "2.50";
document.title = "划词翻译 · 页间";
async function api(path, options) {
  const response = await fetch(path, options),
    data = await response.json();
  if (!response.ok) throw new Error(data.error || "操作没有完成，请重试。");
  return data;
}
const post = (path, body) =>
  api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const translator = createTranslation({
  api,
  post,
  detached: true,
  toast: createToasts(document.getElementById("toasts")),
  closeWindow: () => bridge?.postMessage({ action: "close" }),
  setPinned: (value) => bridge?.postMessage({ action: "pin", value }),
  openSource: (book, position) =>
    bridge?.postMessage({ action: "source", book, position }),
  ask: (context) => bridge?.postMessage({ action: "tutor", context }),
  settings: () => bridge?.postMessage({ action: "settings" }),
});
window.readerTranslationReceive = (request) =>
  translator.open(request.context, null, request.history);
window.readerTranslationDismiss = translator.dismiss;
const updateTheme = () =>
  api("/api/state")
    .then((state) => {
      if (["paper", "sage", "blue", "night"].includes(state.prefs?.theme))
        document.body.dataset.theme = state.prefs.theme;
    })
    .catch(() => {});
updateTheme();
window.addEventListener("focus", () => {
  updateTheme();
  translator.refresh();
});
bridge?.postMessage({ action: "ready" });
let resizeFrame;
const resize = () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    const panel = document.getElementById("translation-panel");
    if (panel.hidden) return;
    const content = document.getElementById(
      document.getElementById("translation-history").hidden
        ? "translation-content"
        : "translation-history",
    );
    const chrome = [...panel.children]
      .filter((node) => !node.classList.contains("translation-scroll"))
      .reduce(
        (height, node) => height + node.getBoundingClientRect().height,
        0,
      );
    bridge?.postMessage({
      action: "resize",
      height: Math.ceil(chrome + content.scrollHeight + 32),
    });
  });
};
const sizeObserver = new ResizeObserver(resize);
for (const id of [
  "translation-content",
  "translation-history",
  "translation-provider",
  "translation-panel",
]) {
  const node =
    id === "translation-provider"
      ? document.querySelector(".translation-provider")
      : document.getElementById(id);
  sizeObserver.observe(node);
}
new MutationObserver(resize).observe(
  document.getElementById("translation-panel"),
  {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["hidden"],
  },
);
