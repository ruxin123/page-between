import assert from "node:assert/strict";
import { transientStatePatch } from "../ui/comparison.mjs";
const draft = {positions:{book:{index:8}},lastBook:"book",prefs:{fontSize:30},bookPrefs:{book:{pdfZoom:200}},bookmarkChanges:{add:[{id:"explicit"}]}};
assert.deepEqual(transientStatePatch(draft), {bookmarkChanges:draft.bookmarkChanges});
assert.deepEqual(transientStatePatch({positions:draft.positions,prefs:draft.prefs}), {});
assert.equal(draft.positions.book.index, 8);
assert.equal(draft.bookPrefs.book.pdfZoom, 200);
console.log("对照阅读不写回位置、续读书籍或排版，主动书签操作保留。");
