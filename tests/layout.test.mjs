import assert from "node:assert/strict";
import { pageCount, pageIndex } from "../page-layout.mjs";
import { palmTypography } from "../core.mjs";

assert.equal(pageCount(780, 780), 1);
assert.equal(pageCount(1560.4, 780), 2); // fractional pixels do not create a blank final page
assert.equal(pageCount(1563, 780), 3);
assert.equal(pageIndex(779, 780, 3), 1);
assert.equal(pageIndex(-200, 780, 3), 0);
assert.equal(pageIndex(4000, 780, 3), 2);
assert.equal(palmTypography(344, 560).size, 16);
assert.equal(palmTypography(280, 440).size, 12.3);
assert.ok(palmTypography(224, 280).size >= 11);
assert.ok(palmTypography(760, 1100).size <= 22);
// Font scaling keeps the estimated characters on a page close across the two real window sizes.
const capacity = (w, h) =>
  ((w - 40) * (h - 84)) / palmTypography(w, h).size ** 2;
assert.ok(Math.abs(capacity(344, 560) / capacity(280, 440) - 1) < 0.02);
console.log("分页边界、空白末页与掌上窗口阅读密度：通过。");
