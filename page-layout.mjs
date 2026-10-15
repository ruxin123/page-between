export function pageCount(extent, width) {
  return Math.max(1, Math.ceil((extent - 1) / Math.max(1, width)));
}

export function pageIndex(left, width, count) {
  return Math.max(
    0,
    Math.min(count - 1, Math.floor((left + 1) / Math.max(1, width))),
  );
}

// Live columns keep text selection, links and original illustrations available during pagination.
export class PageLayout {
  constructor(host, flow, width, height, padding) {
    this.host = host;
    this.flow = flow;
    this.width = Math.floor(width);
    this.page = 0;
    host.style.overflow = "hidden";
    host.style.height = `${Math.floor(height)}px`;
    flow.classList.add("reader-flow");
    Object.assign(flow.style, {
      width: `${this.width}px`,
      height: `${Math.floor(height)}px`,
      minHeight: "0",
      boxSizing: "border-box",
      margin: "0",
      padding: `${padding[0]}px ${padding[1]}px`,
      columnWidth: `${this.width - padding[1] * 2}px`,
      columnGap: `${padding[1] * 2}px`,
      columnFill: "auto",
      transform: "translateX(0)",
      overflow: "visible",
    });
    this.count = pageCount(flow.scrollWidth, this.width);
    host.dataset.pages = this.count;
    this.set(0);
  }
  set(page, animated = false) {
    const next = Math.max(0, Math.min(this.count - 1, page));
    this.animation?.cancel();
    this.incoming?.cancel();
    this.shadowAnimation?.cancel();
    this.sheet?.remove();
    this.host
      .querySelectorAll(".reader-turn-shadow")
      .forEach((element) => element.remove());
    const from = this.flow.style.transform;
    const to = `translateX(${-next * this.width}px)`;
    const direction = Math.sign(next - this.page);
    const turning =
      animated &&
      direction &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches;
    let sheet;
    if (turning && this.flow.textContent.length < 100000) {
      sheet = this.host.ownerDocument.createElement("div");
      sheet.className = "reader-turn-sheet";
      sheet.setAttribute("aria-hidden", "true");
      sheet.inert = true;
      sheet.style.cssText = `position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:5;background:${getComputedStyle(this.host).backgroundColor};box-shadow:var(--turn-shadow);`;
      const copy = this.flow.cloneNode(true);
      copy.removeAttribute("id");
      copy
        .querySelectorAll("[id]")
        .forEach((node) => node.removeAttribute("id"));
      copy.style.transform = from;
      sheet.append(copy);
      const shade = this.host.ownerDocument.createElement("div");
      shade.style.cssText =
        "position:absolute;inset:0;pointer-events:none;background:linear-gradient(90deg,transparent 65%,var(--turn-shade));";
      sheet.append(shade);
      this.host.append(sheet);
      this.sheet = sheet;
    }
    this.flow.style.transform = to;
    if (turning) {
      const timing = { duration: 480, easing: "cubic-bezier(.3,0,.15,1)" };
      // Keep the live text stationary so its selection geometry stays valid during the fade.
      this.incoming = this.flow.animate(
        [{ opacity: 0.35 }, { opacity: 1 }],
        timing,
      );
      this.incoming.finished.catch(() => {});
      // shortcut: unsplit documents over 100k characters fade without cloning the whole book.
      if (sheet) {
        this.animation = sheet.animate(
          [
            { transform: "translateX(0)", opacity: 1 },
            {
              transform: `translateX(${-direction * Math.min(32, this.width * 0.06)}px)`,
              opacity: 0,
            },
          ],
          timing,
        );
        this.animation.finished.then(
          () => sheet.remove(),
          () => sheet.remove(),
        );
      }
      const shadow = this.host.ownerDocument.createElement("div");
      shadow.className = "reader-turn-shadow";
      shadow.style.cssText =
        "position:absolute;inset:0;pointer-events:none;z-index:4;background:linear-gradient(90deg,transparent 30%,var(--turn-highlight) 60%,transparent 90%);";
      this.host.append(shadow);
      this.shadowAnimation = shadow.animate(
        [{ opacity: 0 }, { opacity: 0.5, offset: 0.4 }, { opacity: 0 }],
        timing,
      );
      this.shadowAnimation.finished.then(
        () => shadow.remove(),
        () => shadow.remove(),
      );
    }
    this.page = next;
    this.host.dataset.page = next + 1;
  }
  reveal(element, offset = 0) {
    let rect;
    const doc = element.ownerDocument;
    const walker = doc.createTreeWalker(element, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (offset <= node.length) {
        const range = doc.createRange();
        range.setStart(node, offset);
        range.setEnd(node, Math.min(node.length, offset + 1));
        rect = range.getClientRects()[0];
        break;
      }
      offset -= node.length;
    }
    rect ||= element.getClientRects()[0];
    if (rect)
      this.set(
        pageIndex(
          rect.left - this.flow.getBoundingClientRect().left,
          this.width,
          this.count,
        ),
      );
  }
  destroy() {
    this.animation?.cancel();
    this.incoming?.cancel();
    this.shadowAnimation?.cancel();
    this.sheet?.remove();
    this.flow.classList.remove("reader-flow");
    for (const key of [
      "width",
      "height",
      "minHeight",
      "boxSizing",
      "margin",
      "padding",
      "columnWidth",
      "columnGap",
      "columnFill",
      "transform",
      "overflow",
    ])
      this.flow.style[key] = "";
    this.host.style.height = "";
    this.host.style.overflow = "";
    delete this.host.dataset.page;
    delete this.host.dataset.pages;
    this.host
      .querySelectorAll(".reader-turn-shadow")
      .forEach((element) => element.remove());
  }
}
