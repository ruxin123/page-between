import { icon } from "./shared.mjs";

export function createToasts(root) {
  return function toast(message, { kind = "info", undo } = {}) {
    const doc = root.ownerDocument,
      origin = doc.activeElement;
    const item = doc.createElement("div");
    item.className = "toast";
    item.dataset.kind = kind;
    if (kind === "error") item.setAttribute("role", "alert");
    const symbol = doc.createElement("span");
    symbol.className = "toast-symbol";
    symbol.innerHTML = icon(
      kind === "error" || kind === "warning" ? "warning" : "check",
    );
    const text = doc.createElement("span");
    text.className = "toast-message";
    text.textContent = message;
    item.append(symbol, text);
    let timer,
      closing = false,
      actionRunning = false;
    const stopTimer = () => clearTimeout(timer);
    async function dismiss() {
      if (closing) return;
      closing = true;
      stopTimer();
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
        await item
          .animate(
            [{ opacity: 1 }, { opacity: 0, transform: "translateY(6px)" }],
            { duration: 160 },
          )
          .finished.catch(() => {});
      if (item.contains(doc.activeElement) && origin?.isConnected)
        origin.focus({ preventScroll: true });
      item.remove();
    }
    function startTimer() {
      stopTimer();
      if (
        !closing &&
        !actionRunning &&
        !item.contains(doc.activeElement) &&
        !item.matches(":hover")
      )
        timer = setTimeout(
          dismiss,
          undo ? 8000 : kind === "error" ? 6000 : 3500,
        );
    }
    if (undo) {
      const button = doc.createElement("button");
      button.className = "toast-undo";
      button.textContent = "撤销";
      button.setAttribute("aria-label", `撤销：${message}`);
      button.onclick = async () => {
        actionRunning = true;
        stopTimer();
        button.disabled = true;
        try {
          await undo();
          await dismiss();
        } catch (error) {
          toast("撤销未完成：" + error.message, { kind: "error" });
        } finally {
          actionRunning = false;
          button.disabled = false;
          startTimer();
        }
      };
      item.append(button);
    }
    const close = doc.createElement("button");
    close.className = "toast-close";
    close.innerHTML = icon("close");
    close.setAttribute("aria-label", "关闭通知");
    close.onclick = dismiss;
    item.append(close);
    item.addEventListener("pointerenter", stopTimer);
    item.addEventListener("pointerleave", startTimer);
    item.addEventListener("focusin", stopTimer);
    item.addEventListener("focusout", () => queueMicrotask(startTimer));
    if (root.children.length >= 3) {
      const oldest = [...root.children].find(
        (node) => !node.contains(doc.activeElement),
      );
      oldest?.querySelector(".toast-close").click();
    }
    root.append(item);
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
      item.animate(
        [
          { opacity: 0, transform: "translateY(8px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        { duration: 220, easing: "cubic-bezier(.16,1,.3,1)" },
      );
    startTimer();
  };
}
