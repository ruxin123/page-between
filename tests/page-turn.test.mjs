import assert from "node:assert/strict";
import { PageLayout, characterRect } from "../page-layout.mjs";

const animations = [];
class Motion {
  constructor(frames) {
    this.frames = frames;
    this.finished = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    animations.push(this);
  }
  cancel() {
    this.reject(new Error("cancelled"));
  }
  finish() {
    this.resolve();
  }
}
class Element {
  style = {};
  dataset = {};
  children = [];
  className = "";
  textContent = "Original generated text";
  scrollWidth = 2340;
  classList = { add() {}, remove() {} };
  ownerDocument = { createElement: () => new Element() };
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (node) => node !== this,
      );
  }
  setAttribute() {}
  removeAttribute() {}
  querySelectorAll(selector) {
    return this.children.filter((node) => selector === "." + node.className);
  }
  cloneNode() {
    const node = new Element();
    node.style = { ...this.style };
    return node;
  }
  animate(frames) {
    return new Motion(frames);
  }
}
let reduced = false;
globalThis.matchMedia = () => ({ matches: reduced });
globalThis.getComputedStyle = () => ({ backgroundColor: "#fffefa" });
const host = new Element(),
  flow = new Element();
const layout = new PageLayout(host, flow, 780, 800, [40, 50]);
layout.set(1, true);
assert.equal(flow.style.transform, "translateX(-780px)");
assert.ok(
  layout.incoming.frames.every((frame) => !("transform" in frame)),
  "The live selection layer stays stationary during a turn.",
);
layout.set(2, true);
await Promise.resolve();
assert.equal(
  host.children.length,
  2,
  "Rapid turns keep only the current temporary sheet and shadow.",
);
for (const animation of animations) animation.finish();
await Promise.resolve();
assert.equal(
  host.children.length,
  0,
  "Finished and cancelled animations release temporary DOM.",
);
const before = animations.length;
reduced = true;
layout.set(0, true);
assert.equal(
  animations.length,
  before,
  "Reduced motion changes pages without animation.",
);
assert.equal(host.dataset.page, 1);

const first = { length: 3, left: 10 },
  second = { length: 5, left: 790 },
  empty = { length: 0 };
const paragraph = {
  ownerDocument: {
    createTreeWalker() {
      let i = 0;
      return { nextNode: () => [first, second, empty][i++] };
    },
    createRange() {
      let node, start, end;
      return {
        setStart(n, offset) {
          node = n;
          start = offset;
        },
        setEnd(n, offset) {
          end = offset;
        },
        getClientRects() {
          return start === end || node.invisible
            ? []
            : [{ left: node.left, top: 20 }];
        },
      };
    },
  },
  getClientRects: () => [{ left: 10, top: 20 }],
};
flow.getBoundingClientRect = () => ({ left: 0 });
layout.reveal(paragraph, 3);
assert.equal(
  layout.page,
  1,
  "An inline-node boundary reveals the next column, not the paragraph start.",
);
layout.reveal(paragraph, 8);
assert.equal(
  layout.page,
  1,
  "Paragraph end uses its last non-empty text node.",
);
assert.equal(characterRect(paragraph, 100).left, 790);
first.invisible = true;
layout.reveal(paragraph, 0);
assert.equal(
  layout.page,
  0,
  "Invisible leading whitespace must not jump to the last column.",
);
layout.destroy();
console.log("换页几何保持、连续翻页取消、临时层清理与减少动态效果：通过。");
