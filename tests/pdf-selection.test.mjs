import assert from "node:assert/strict";
import { mappedFragment } from "../ui/pdf-selection.mjs";

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
