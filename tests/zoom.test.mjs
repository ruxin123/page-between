import assert from "node:assert/strict";
import { nextZoom, parseZoom } from "../ui/zoom.mjs";
assert.equal(nextZoom(100, 1, 25, 400), 110);
assert.equal(nextZoom(66.55, 1, 25, 400), 75);
assert.equal(nextZoom(119, -1, 50, 200), 110);
assert.equal(nextZoom(119, 1, 50, 200), 125);
assert.equal(nextZoom(400, 1, 25, 400), 400);
assert.equal(nextZoom(50, -1, 50, 200), 50);
assert.equal(parseZoom("110%", 25, 400), 110);
assert.equal(parseZoom(" 125.4 % ", 50, 200), 125);
assert.equal(parseZoom("1000", 25, 400), 400);
assert.equal(parseZoom("1", 50, 200), 50);
for (const invalid of ["", "-100", "1e2", "Infinity", "100%%", "abc", "12.3.4"])
  assert.equal(parseZoom(invalid, 25, 400), null);
console.log("缩放分级、精确比例、范围与无效输入：通过。");
