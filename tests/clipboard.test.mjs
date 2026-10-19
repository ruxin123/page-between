import assert from "node:assert/strict";
import { copyPng } from "../ui/clipboard.mjs";
let finishDecoding, items;
globalThis.Image = class {
  naturalWidth = 20;
  naturalHeight = 10;
  decode() {
    return new Promise((resolve) => {
      finishDecoding = resolve;
    });
  }
};
globalThis.document = {
  createElement: () => ({
    getContext: () => ({ drawImage() {} }),
    toBlob(callback, type) {
      callback(new Blob(["test"], { type }));
    },
  }),
};
globalThis.ClipboardItem = class {
  constructor(data) {
    this.data = data;
  }
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    clipboard: {
      write(value) {
        items = value;
        return value[0].data["image/png"].then((blob) =>
          assert.equal(blob.type, "image/png"),
        );
      },
    },
  },
});
const copying = copyPng("data:image/png;base64,fixture");
assert.ok(
  items,
  "Clipboard write starts within the original click, before asynchronous decoding.",
);
assert.equal(typeof items[0].data["image/png"].then, "function");
finishDecoding();
await copying;
console.log("图片复制保持 WebKit 用户操作时机，并等待图片就绪：通过。");
