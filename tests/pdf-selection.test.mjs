import assert from "node:assert/strict";
import { mappedFragment } from "../ui/pdf-selection.mjs";
import { englishLineCells } from "../ui/ocr-layer.mjs";

const line = {
  text: "Wi. A",
  bbox: [0.1, 0.1, 0.45, 0.2],
  segments: [
    { text: "W", bbox: [0.1, 0.1, 0.2, 0.2] },
    { text: "i", bbox: [0.22, 0.12, 0.25, 0.18] },
    { text: ". ", bbox: [0.27, 0.18, 0.28, 0.2] },
    { text: "A ", bbox: [0.35, 0.1, 0.45, 0.2] },
  ],
};
const original = structuredClone(line),
  cells = englishLineCells(line);
assert.equal(cells.map((cell) => cell.text).join(""), line.text);
assert.ok(cells.every((cell) => cell.bbox[1] === 0.1 && cell.bbox[3] === 0.2));
assert.deepEqual(
  cells.find((cell) => cell.text === " ").bbox,
  [0.28, 0.1, 0.35, 0.2],
);
assert.ok(cells.slice(1).every((cell, i) => cell.bbox[0] >= cells[i].bbox[2]));
assert.deepEqual(line, original);
const overlapping = englishLineCells({
  bbox: [0, 0, 1, 0.1],
  segments: [
    { text: "m", bbox: [0.1, 0, 0.2, 0.1] },
    { text: "i ", bbox: [0.1, 0, 0.2, 0.1] },
    { text: "A", bbox: [0.3, 0, 0.4, 0.1] },
  ],
});
assert.deepEqual(
  overlapping.map((cell) => cell.text),
  ["mi", " ", "A"],
);
assert.deepEqual(overlapping[0].bbox, [0.1, 0, 0.2, 0.1]);
assert.deepEqual(englishLineCells({ text: "one word", bbox: [0, 0, 1, 0.1] }), [
  { text: "one word", bbox: [0, 0, 1, 0.1] },
]);

assert.deepEqual(
  mappedFragment("ab cd", [[0, 1], [1, 2], null, [3, 4], [4, 5]], 0, 5),
  [0, 5],
);
assert.equal(mappedFragment("abc", [[0, 1], null, [2, 3]], 0, 3), null);
assert.deepEqual(
  mappedFragment(
    "f(x)",
    [
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 7],
    ],
    2,
    3,
    [[2, 8]],
  ),
  [2, 8],
);
console.log("PDF 选区保留原始字符边界，模糊结果回退，行内公式整体展开：通过。");
