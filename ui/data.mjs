import { downloadFile } from "./export.mjs";

export function createDataSettings({ api, post, toast }) {
  const $ = (id) => document.getElementById(id);
  const bridge = window.webkit?.messageHandlers?.appNative;
  let busy = false;
  function bytes(value) {
    return value < 1024 ** 2
      ? `${(value / 1024).toFixed(0)} KB`
      : value < 1024 ** 3
        ? `${(value / 1024 ** 2).toFixed(1)} MB`
        : `${(value / 1024 ** 3).toFixed(2)} GB`;
  }
  async function show() {
    try {
      const data = await api("/api/data/info");
      $("data-books").textContent = `${data.books} 本`;
      $("data-size").textContent = bytes(data.libraryBytes);
      $("data-cache-size").textContent = bytes(data.cacheBytes);
      $("data-reveal").hidden = !bridge;
      $("data-restore-review").hidden = !data.pendingRestore;
      $("data-restore-summary").textContent = data.pendingRestore
        ? `${data.restoreBooks} 本备份已校验。确认后将在下次启动替换当前 ${data.books} 本书的书库；当前书库另行保留，服务配置和凭据保持。`
        : "";
      $("data-confirm-restore").textContent = data.restoreApproved
        ? "已确认 · 立即重启"
        : bridge
          ? "确认恢复并重启"
          : "确认恢复（下次启动生效）";
      $("data-previous").hidden = !data.previousAvailable;
      $("data-restart").hidden = !data.pendingCacheClear;
      $("data-last-restore").textContent = data.lastRestore.message || "";
    } catch (error) {
      $("data-status").textContent = error.message;
    }
  }
  async function run(message, action) {
    if (busy) return;
    busy = true;
    $("data-actions").disabled = true;
    $("data-status").textContent = message;
    try {
      await action();
    } catch (error) {
      $("data-status").textContent = error.message;
      toast(error.message, { kind: "error" });
    } finally {
      busy = false;
      $("data-actions").disabled = false;
      await show();
    }
  }
  function restart() {
    if (bridge) bridge.postMessage({ action: "restartLibrary" });
    else $("data-status").textContent = "已准备，重新启动应用后生效。";
  }
  $("data-backup").onclick = () =>
    run("正在打包并校验书库，可继续阅读…", async () => {
      const result = await post("/api/data/backup", {});
      downloadFile(result);
      $("data-status").textContent =
        `已准备 ${result.books} 本书及阅读记录的备份，请选择保存位置。`;
    });
  $("data-restore").onclick = () => $("data-restore-file").click();
  $("data-restore-file").onchange = (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    run("正在检查备份，当前书库保持可用…", async () => {
      await api("/api/data/restore", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      $("data-status").textContent = "校验完成，请查看恢复说明后确认。";
    });
  };
  $("data-confirm-restore").onclick = () =>
    run("正在确认恢复…", async () => {
      await post("/api/data/approve-restore", {});
      restart();
    });
  $("data-cancel-restore").onclick = () =>
    run("正在取消准备的恢复…", async () => {
      await post("/api/data/cancel-restore", {});
      $("data-status").textContent = "已取消，当前书库保持。";
    });
  $("data-previous").onclick = () =>
    run("正在校验恢复前保留的书库…", async () => {
      await post("/api/data/previous", {});
      $("data-status").textContent = "已准备恢复前的书库，请确认。";
    });
  $("data-clear-cache").onclick = () =>
    run("正在准备清理…", async () => {
      await post("/api/data/clear-cache", {});
      $("data-status").textContent =
        "重启时清理可重新生成的缓存，书籍、阅读记录和服务设置保留。";
    });
  $("data-restart").onclick = restart;
  $("data-reveal").onclick = () =>
    bridge?.postMessage({ action: "revealLibrary" });
  return { show };
}
