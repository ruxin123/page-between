import assert from "node:assert/strict";
import { referenceMatches } from "../ui/knowledge.mjs";
assert.deepEqual(
  referenceMatches("由定理 2.3 和 Lemma 4.2.1 得出结论。").map(
    (match) => match[0],
  ),
  ["定理 2.3", "Lemma 4.2.1"],
);
assert.deepEqual(
  referenceMatches("Theorem 1.2. A function...").map((match) => match[0]),
  ["Theorem 1.2"],
);
assert.equal(referenceMatches("A definition of a theorem in 2026.").length, 0);
console.log("书内编号引用识别保留编号边界，不误认普通正文：通过。");
