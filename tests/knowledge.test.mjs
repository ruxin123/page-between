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

const { pdfTocAtPosition } = await import("../ui/navigation.mjs");
const sections = [
  { title: "Earlier", index: 1, pdfY: 0.7 },
  {
    title: "Main",
    index: 2,
    pdfY: 0.2,
    children: [
      { title: "Middle", index: 2, pdfY: 0.5 },
      { title: "Bottom", index: 2, pdfY: 0.96 },
    ],
  },
];
assert.equal(pdfTocAtPosition(sections, 1, 0.1), null);
assert.equal(pdfTocAtPosition(sections, 2, 0.1).title, "Earlier");
assert.equal(pdfTocAtPosition(sections, 2, 0.3).title, "Main");
assert.equal(pdfTocAtPosition(sections, 2, 0.6).title, "Middle");
assert.equal(pdfTocAtPosition(sections, 2, 0.97).title, "Bottom");
assert.equal(
  pdfTocAtPosition([{ title: "Scan chapter", index: 1 }], 1, 0).title,
  "Scan chapter",
);
