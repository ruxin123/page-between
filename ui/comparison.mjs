import { icon } from "./shared.mjs";

export function transientStatePatch(patch) {
  const { positions, lastBook, prefs, bookPrefs, ...explicit } = patch;
  return explicit;
}

export function createComparison({ getSeed, layout, closed }) {
  const pane = document.createElement("aside");
  pane.id = "comparison-reference";
  pane.className = "comparison-pane";
  pane.hidden = true;
  pane.setAttribute("aria-label", "对照阅读");
  pane.innerHTML = `<div class="comparison-handle" role="separator" tabindex="0" aria-label="调整对照大小" aria-orientation="vertical" aria-valuemin="30" aria-valuemax="70" aria-valuenow="50"></div><header><strong>对照</strong><button class="icon-button" data-close aria-label="关闭对照">${icon("close")}</button></header><div class="comparison-loading" role="status">正在打开…</div>`;
  const switcher = document.createElement("nav");
  switcher.className = "comparison-switcher";
  switcher.hidden = true;
  switcher.setAttribute("aria-label", "对照视图");
  switcher.innerHTML = `<div role="tablist" aria-label="阅读位置"><button id="comparison-main-tab" role="tab" aria-controls="reader" data-view="main">正文</button><button id="comparison-reference-tab" role="tab" aria-controls="comparison-reference" data-view="reference">对照</button></div><button data-close aria-label="关闭对照">${icon("close")}</button>`;
  document.body.append(pane, switcher);
  const handle = pane.querySelector("[role=separator]"), status = pane.querySelector("[role=status]");
  let frame, seed, size = 50, timer;
  const reader = document.getElementById("reader");
  const narrow = matchMedia("(max-width: 899px)");
  let active = "reference";
  function showActive(view, focus = false) {
    active = view;
    document.body.dataset.comparisonLayout = narrow.matches ? "switch" : "split";
    document.body.dataset.comparisonActive = active;
    switcher.hidden = !narrow.matches;
    handle.hidden = narrow.matches;
    reader.inert = narrow.matches && active === "reference";
    pane.inert = narrow.matches && active === "main";
    for (const tab of switcher.querySelectorAll("[role=tab]")) {
      const selected = tab.dataset.view === active;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const [panel, tab] of [[reader, "main"], [pane, "reference"]]) {
      if (narrow.matches) {
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", `comparison-${tab}-tab`);
      } else {
        panel.removeAttribute("role");
        panel.removeAttribute("aria-labelledby");
      }
    }
    if (focus && narrow.matches) switcher.querySelector('[aria-selected="true"]').focus();
  }
  switcher.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (button?.dataset.view) showActive(button.dataset.view);
    else if (button) close();
  });
  switcher.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.target.matches("[role=tab]") && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      showActive(event.key === "Home" ? "main" : event.key === "End" ? "reference" : active === "main" ? "reference" : "main", true);
    }
  });
  narrow.addEventListener("change", () => {
    if (pane.hidden) return;
    const focus = document.activeElement;
    if (narrow.matches) {
      const view = pane.contains(focus) ? "reference" : reader.contains(focus) ? "main" : active;
      showActive(view);
    } else {
      showActive(active);
      if (switcher.contains(focus)) {
        const target = active === "main" ? reader.querySelector("#reading-viewport")
          : frame?.contentDocument?.getElementById("reading-viewport") || frame;
        target?.focus({ preventScroll: true });
      }
    }
  });
  function bounds() {
    const minimum = Math.min(45, Math.max(30, 300 / innerWidth * 100));
    return [minimum, 100 - minimum];
  }
  function setSize(value, remember = true) {
    const [low, high] = bounds();
    const displayed = Math.max(low, Math.min(high, value));
    if (remember) size = displayed;
    handle.setAttribute("aria-valuenow", String(Math.round(displayed)));
    handle.setAttribute("aria-valuemin", String(Math.ceil(low)));
    handle.setAttribute("aria-valuemax", String(Math.floor(high)));
    document.documentElement.style.setProperty("--comparison-size", displayed + "vw");
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
      delete document.body.dataset.comparison;
      delete document.body.dataset.comparisonLayout;
      delete document.body.dataset.comparisonActive;
      reader.inert = false;
      reader.removeAttribute("role");
      reader.removeAttribute("aria-labelledby");
      switcher.hidden = true;
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
    handle.onpointermove = event => layout(() => setSize((innerWidth - event.clientX) / innerWidth * 100));
    handle.onpointerup = handle.onpointercancel = () => { handle.onpointermove = null; };
  };
  handle.onkeydown = event => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    layout(() => setSize(event.key === "Home" ? 50 : size + (["ArrowLeft", "ArrowUp"].includes(event.key) ? 5 : -5)));
  };
  window.addEventListener("resize", () => { if (!pane.hidden) setSize(size, false); });
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
        setSize(size, false);
        showActive("reference", true);
      });
      load();
    },
  };
}
