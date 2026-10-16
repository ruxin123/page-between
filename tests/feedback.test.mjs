import assert from "node:assert/strict";
import { createToasts } from "../ui/feedback.mjs";

class Element {
  children = [];
  attributes = {};
  dataset = {};
  isConnected = true;
  hidden = false;
  constructor(doc) {
    this.ownerDocument = doc;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  remove() {
    this.parent.children = this.parent.children.filter((node) => node !== this);
    this.isConnected = false;
  }
  contains(node) {
    return this === node || this.children.some((child) => child.contains(node));
  }
  closest() {
    return this.hidden ? this : null;
  }
  getClientRects() {
    return this.hidden ? [] : [{}];
  }
  setAttribute(key, value) {
    this.attributes[key] = value;
  }
  removeAttribute(key) {
    delete this.attributes[key];
  }
  matches() {
    return false;
  }
  addEventListener() {}
  focus() {
    this.ownerDocument.activeElement = this;
  }
  querySelector(selector) {
    return this.children.find((node) => "." + node.className === selector);
  }
}
globalThis.matchMedia = () => ({ matches: true });
const doc = {
  createElement() {
    return new Element(this);
  },
};
doc.body = new Element(doc);
const root = new Element(doc),
  original = new Element(doc),
  filter = new Element(doc);
doc.activeElement = filter;
const toast = createToasts(root);
let complete,
  calls = 0;
original.hidden = true;
toast("已移出常读。", {
  focusTarget: original,
  undo: async () => {
    calls++;
    await new Promise((resolve) => {
      complete = resolve;
    });
    original.hidden = false;
  },
});
const undo = root.children[0].querySelector(".toast-undo");
undo.focus();
const pending = undo.onclick();
await undo.onclick();
assert.equal(
  calls,
  1,
  "Repeated activation during an undo only sends one request.",
);
assert.equal(
  doc.activeElement,
  undo,
  "A busy action keeps its keyboard focus.",
);
complete();
await pending;
assert.equal(
  doc.activeElement,
  original,
  "Undo restores the explicitly captured star, not the filter.",
);
assert.equal(root.children.length, 0);

original.hidden = true;
doc.activeElement = filter;
toast("已移出常读。", { focusTarget: original, undo: async () => {} });
const close = root.children[0].querySelector(".toast-close");
close.focus();
await close.onclick();
assert.notEqual(
  doc.activeElement,
  original,
  "Closing a notification cannot focus a hidden card.",
);

doc.activeElement = filter;
toast("示例", {
  focusTarget: original,
  undo: async () => {
    original.hidden = false;
    doc.activeElement = filter;
  },
});
const action = root.children[0].querySelector(".toast-undo");
action.focus();
await action.onclick();
assert.equal(
  doc.activeElement,
  filter,
  "Undo does not steal focus if the user moved elsewhere while it ran.",
);
console.log("撤销焦点恢复、隐藏控件保护与重复提交防护：通过。");
