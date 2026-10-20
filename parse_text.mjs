import { parseChapters } from "./core.mjs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { text, enabled } = JSON.parse(input);
const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
const chapters = enabled
  ? parseChapters(normalized)
  : [
      {
        title: "全文",
        body: normalized.trim(),
        volume: "",
        sourceOffset: normalized.indexOf(normalized.trim()),
        sourceEnd:
          normalized.indexOf(normalized.trim()) + normalized.trim().length,
      },
    ];
process.stdout.write(
  JSON.stringify(
    chapters.map((chapter) => ({
      ...chapter,
      characters: chapter.body.length,
    })),
  ),
);
