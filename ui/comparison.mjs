import { icon } from "./shared.mjs";

export function transientStatePatch(patch) {
  const { positions, lastBook, prefs, bookPrefs, ...explicit } = patch;
  return explicit;
}

export function createComparison({ getSeed, layout, closed }) {
  const pane = document.createElement("aside");
  pane.className = "comparison-pane";
  pane.hidden = true;
  pane.setAttribute("aria-label", "对照阅读");
  pane.innerHTML = `<div class="comparison-handle" role="separator" tabindex="0" aria-label="调整对照大小" aria-orientation="vertical" aria-valuemin="30" aria-valuemax="70" aria-valuenow="50"></div><header><strong>对照</strong><button class="icon-button" data-close aria-label="关闭对照">${icon("close")}</button></header><div class="comparison-loading" role="status">正在打开…</div>`;
  document.body.append(pane);
  const handle = pane.querySelector("[role=separator]"), status = pane.querySelector("[role=status]");
  let frame, seed, size = 50, timer;
  const stacked = () => innerWidth < 900;
  function bounds() {
    const extent = stacked() ? innerHeight : innerWidth;
    const minimum = Math.min(45, Math.max(30, 300 / extent * 100));
    return [minimum, 100 - minimum];
  }
  function setSize(value) {
    const [low, high] = bounds();
    size = Math.max(low, Math.min(high, value));
    handle.setAttribute("aria-valuenow", String(Math.round(size)));
    handle.setAttribute("aria-valuemin", String(Math.ceil(low)));
    handle.setAttribute("aria-valuemax", String(Math.floor(high)));
    handle.setAttribute("aria-orientation", stacked() ? "horizontal" : "vertical");
    document.documentElement.style.setProperty("--comparison-size", size + (stacked() ? "dvh" : "vw"));
  }
  function load() {
    clearTimeout(timer);
    frame?.remove();
    status.textContent = "正在打开…";
    status.hidden = false;
    frame = document.createElement("iframe");
    frame.title = "对照阅读正文";
    const url = new URL("/", location.href);
    url.searchParams.set("mode", "reference");
    url.searchParams.set("book", seed.book);
    url.hash = "/read/" + seed.book;
    frame.src = url.href;
    pane.append(frame);
    timer = setTimeout(() => {
      status.textContent = "暂时无法打开。";
      const retry = document.createElement("button");
      retry.className = "secondary-button"; retry.textContent = "重试"; retry.onclick = load;
      status.append(retry);
    }, 30000);
  }
  function close(reflow = true) {
    if (pane.hidden) return;
    clearTimeout(timer);
    const remove = () => {
      pane.hidden = true;
      frame?.remove(); frame = null;
      document.body.removeAttribute("data-comparison");
      document.getElementById("comparison-open").setAttribute("aria-pressed", "false");
    };
    if (reflow) layout(remove); else remove();
    closed(reflow);
  }
  pane.querySelector("[data-close]").onclick = () => close();
  window.addEventListener("message", event => {
    if (pane.hidden || event.origin !== location.origin || event.source !== frame?.contentWindow) return;
    if (event.data?.type === "page-between-reference-ready") {
      frame.contentWindow.postMessage({type: "page-between-reference-init", seed}, location.origin);
    } else if (event.data?.type === "page-between-reference-opened") {
      clearTimeout(timer); status.hidden = true;
    }
  });
  handle.onpointerdown = event => {
    if (event.button !== 0) return;
    event.preventDefault(); handle.setPointerCapture(event.pointerId);
    handle.onpointermove = event => layout(() => setSize((stacked() ? innerHeight - event.clientY : innerWidth - event.clientX) / (stacked() ? innerHeight : innerWidth) * 100));
    handle.onpointerup = handle.onpointercancel = () => { handle.onpointermove = null; };
  };
  handle.onkeydown = event => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    layout(() => setSize(event.key === "Home" ? 50 : size + (["ArrowLeft", "ArrowUp"].includes(event.key) ? 5 : -5)));
  };
  window.addEventListener("resize", () => { if (!pane.hidden) setSize(size); });
  return {
    get open() { return !pane.hidden; },
    close,
    show() {
      if (!pane.hidden) { frame?.focus(); return; }
      seed = getSeed();
      if (!seed) return;
      layout(() => {
        pane.hidden = false;
        document.body.dataset.comparison = "open";
        document.getElementById("comparison-open").setAttribute("aria-pressed", "true");
        setSize(size);
      });
      load();
    },
  };
}
