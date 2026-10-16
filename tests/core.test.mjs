import assert from "node:assert/strict";
import {
  parseChapters,
  decodeBook,
  chapterProgress,
  shouldFollowPosition,
} from "../core.mjs";

const positionChange = {
  revision: 4,
  seen: 4,
  remote: { updatedAt: 200 },
  local: { updatedAt: 100 },
};
assert.equal(
  shouldFollowPosition({ ...positionChange, allowed: false }),
  false,
);
assert.equal(
  shouldFollowPosition({ ...positionChange, allowed: true }),
  true,
  "After editing ends, an already observed remote position still applies.",
);
assert.equal(
  shouldFollowPosition({ ...positionChange, revision: 3, allowed: true }),
  false,
  "An older response cannot replace a newer state.",
);
assert.equal(
  shouldFollowPosition({
    ...positionChange,
    local: { updatedAt: 300 },
    allowed: true,
  }),
  false,
);
assert.equal(
  shouldFollowPosition({ ...positionChange, remote: undefined, allowed: true }),
  false,
);

const chapters = parseChapters(
  "\ufeff书名\r\n\r\n第一章 雨夜\r\n第一段\r\n\r\n第二章 来信\r\n第二段",
);
assert.equal(chapters.length, 3);
assert.equal(chapters[0].title, "卷首");
assert.equal(chapters[1].body, "第一段");
assert.equal(chapters[2].title, "第二章 来信");
assert.equal(parseChapters("第一章介绍了集合。\n这是正文。").length, 1);
assert.equal(
  parseChapters("Chapter I — Arrival\nText\nChapter II: Morning\nMore").length,
  2,
);
assert.equal(
  parseChapters("第 12 章：新的开始\n正文")[0].title,
  "第 12 章：新的开始",
);
const volume = parseChapters(
  "第一卷 雨季\n\n第一章 来信\nA\n第二章 河岸\nB\n第二卷 放晴\n第三章 归途\nC",
);
assert.equal(volume.length, 3);
assert.equal(volume[0].volume, "第一卷 雨季");
assert.equal(volume[2].volume, "第二卷 放晴");
assert.equal(
  parseChapters("<script>alert(1)</script>\n普通文字")[0].body,
  "<script>alert(1)</script>\n普通文字",
);
assert.equal(
  decodeBook(new TextEncoder().encode("中文\n第一章").buffer),
  "中文\n第一章",
);
assert.equal(decodeBook(new Uint8Array([0xff, 0xfe, 0x2d, 0x4e]).buffer), "中");
assert.equal(decodeBook(new Uint8Array([0xfe, 0xff, 0x4e, 0x2d]).buffer), "中");
assert.equal(
  decodeBook(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]).buffer),
  "中文",
);
assert.equal(
  chapterProgress([{ body: "1234" }, { body: "123456" }], 1, 0.5),
  0.7,
);
assert.equal(
  chapterProgress(
    [
      { body: "", characters: 4 },
      { body: "", characters: 6 },
    ],
    1,
    0.5,
  ),
  0.7,
);

// A generated long book verifies chapter boundaries without requiring private reading material.
const expected = Array.from({ length: 120 }, (_, index) => ({
  title: `第${index + 1}章 示例章节`,
  volume: `第${Math.floor(index / 15) + 1}卷 示例分卷`,
  body: `段落 ${index + 1}。这是一段自编的章节测试文本。\n\n另一段 ${index + 1}。`,
}));
const text = expected
  .map(
    (chapter, index) =>
      (index % 15 === 0 ? chapter.volume + "\n" : "") +
      chapter.title +
      "\n" +
      chapter.body,
  )
  .join("\n");
const parsed = parseChapters(text);
assert.equal(parsed.length, 120);
assert.deepEqual(
  parsed.map(({ title, volume, body }) => ({ title, volume, body })),
  expected,
);
assert.equal(new Set(parsed.map((chapter) => chapter.volume)).size, 8);
for (const chapter of parsed)
  assert.equal(
    text.slice(
      chapter.sourceOffset,
      chapter.sourceOffset + chapter.body.length,
    ),
    chapter.body,
  );
console.log("章节、编码、生成长书的 120 章／8 卷、正文边界与进度：通过。");
