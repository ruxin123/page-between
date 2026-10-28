import { icon } from "./shared.mjs";

export const zoomSteps = [
  25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400,
];
export function nextZoom(value, direction, min, max) {
  value = Math.round(value);
  return direction > 0
    ? (zoomSteps.find((step) => step > value + 0.01 && step <= max) ?? max)
    : (zoomSteps.findLast((step) => step < value - 0.01 && step >= min) ?? min);
}
export function parseZoom(text, min, max) {
  if (!/^\s*\d+(?:\.\d+)?\s*%?\s*$/.test(text)) return null;
  const value = Number(text.replace(/[%\s]/g, ""));
  return Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : null;
}

export function createReaderZoom({ roots, getState, change, toast }) {
  for (const root of roots) {
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "阅读缩放");
    root.innerHTML = `<button type="button" data-zoom="out" aria-label="缩小" title="缩小 · ⌘−">${icon("minus")}</button><input data-zoom-input type="text" inputmode="decimal" aria-label="缩放百分比" autocomplete="off" spellcheck="false"><select data-zoom-presets aria-label="选择缩放比例"><option value="">比例</option><option value="width" data-pdf-fit>适合宽度</option><option value="page" data-pdf-fit>适合整页</option>${zoomSteps.map((step) => `<option value="${step}">${step}%</option>`).join("")}</select><button type="button" data-zoom="in" aria-label="放大" title="放大 · ⌘＋">${icon("plus")}</button>`;
    const input = root.querySelector("input"),
      select = root.querySelector("select");
    root.querySelector('[data-zoom="out"]').onclick = () => step(-1);
    root.querySelector('[data-zoom="in"]').onclick = () => step(1);
    input.onfocus = () => input.select();
    const commit = () => {
      const state = getState(),
        value = parseZoom(input.value, state.min, state.max);
      if (value === null)
        toast("请输入有效的缩放百分比。", { kind: "warning" });
      else apply(value);
      update(true);
    };
    input.onchange = commit;
    input.onkeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
        input.blur();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        update(true);
        input.blur();
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        step(event.key === "ArrowUp" ? 1 : -1);
      }
    };
    select.onchange = () => {
      if (select.value)
        apply(
          ["width", "page"].includes(select.value)
            ? select.value
            : Number(select.value),
        );
      select.value = "";
    };
  }
  function apply(value) {
    if (!getState().enabled || getState().hidden) return;
    Promise.resolve(change(value)).catch((error) =>
      toast(error.message, { kind: "error" }),
    );
  }
  function step(direction) {
    const state = getState();
    apply(nextZoom(state.value, direction, state.min, state.max));
    update(true);
  }
  function update(force = false) {
    const state = getState();
    for (const root of roots) {
      root.hidden = state.hidden;
      const input = root.querySelector("input");
      if (force || document.activeElement !== input)
        input.value = `${Math.round(state.value)}%`;
      input.title = `${state.pdf ? "页面缩放" : "字号比例"} · ${state.min}%–${state.max}%`;
      for (const node of root.querySelectorAll("button,input,select"))
        node.disabled = !state.enabled;
      root.querySelector('[data-zoom="out"]').disabled ||=
        state.value <= state.min;
      root.querySelector('[data-zoom="in"]').disabled ||=
        state.value >= state.max;
      for (const option of root.querySelectorAll("option")) {
        option.hidden = option.hasAttribute("data-pdf-fit")
          ? !state.pdf
          : option.value &&
            Number.isFinite(Number(option.value)) &&
            (Number(option.value) < state.min ||
              Number(option.value) > state.max);
        option.disabled = option.hidden;
      }
    }
  }
  return { update, step, reset: () => apply(100) };
}
