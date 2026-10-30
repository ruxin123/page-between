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
      $("data-cache-details").textContent =
        (data.cacheCategories || [])
          .filter((item) => item.bytes > 0)
          .map((item) => `${item.label} ${bytes(item.bytes)}`)
          .join(" · ") || "没有可清理的缓存。";
      $("data-reveal").hidden = !bridge;
      $("data-restore-review").hidden = !data.pendingRestore;
      $("data-restore-summary").textContent = data.pendingRestore
        ? `${data.restoreBooks} 本书将替换当前 ${data.books} 本书，当前书库会保留为恢复点。`
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
    run("正在生成备份…", async () => {
      const result = await post("/api/data/backup", {});
      downloadFile(result);
      $("data-status").textContent =
        "备份已生成。";
    });
  $("data-restore").onclick = () => $("data-restore-file").click();
  $("data-restore-file").onchange = (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    run("正在检查备份…", async () => {
      await api("/api/data/restore", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      $("data-status").textContent = "请选择是否恢复。";
    });
  };
  $("data-confirm-restore").onclick = () =>
    run("正在确认恢复…", async () => {
      await post("/api/data/approve-restore", {});
      restart();
    });
  $("data-cancel-restore").onclick = () =>
    run("正在取消…", async () => {
      await post("/api/data/cancel-restore", {});
      $("data-status").textContent = "已取消。";
    });
  $("data-previous").onclick = () =>
    run("正在检查恢复点…", async () => {
      await post("/api/data/previous", {});
      $("data-status").textContent = "请选择是否恢复。";
    });
  $("data-clear-cache").onclick = () =>
    run("正在准备清理…", async () => {
      await post("/api/data/clear-cache", {});
      $("data-status").textContent =
        "重启后清理缓存，书籍与记录保留。";
    });
  $("data-restart").onclick = restart;
  $("data-reveal").onclick = () =>
    bridge?.postMessage({ action: "revealLibrary" });
  return { show };
}
