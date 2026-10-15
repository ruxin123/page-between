const headingPattern =
  /^(?:第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[章节回卷部篇](?:\s|[：:、.．—-]|$).*|(?:chapter|part|book)\s+(?:\d+|[ivxlcdm]+)(?:\s|[.:—-]|$).*|(?:序章|序言|前言|引子|楔子|尾声|后记|终章)(?:\s|[：:、—-]|$).*)$/iu;
const volumePattern =
  /^(?:第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[卷部篇]|(?:part|book)\s)/iu;

export function parseChapters(input) {
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const headings = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const title = line.trim();
    if (title.length <= 80 && headingPattern.test(title))
      headings.push({ title, offset, end: offset + line.length });
    offset += line.length + 1;
  }
  if (!headings.length)
    return [
      {
        title: "全文",
        body: text.trim(),
        volume: "",
        sourceOffset: text.indexOf(text.trim()),
      },
    ];
  const chapters = [];
  const prefix = text.slice(0, headings[0].offset).trim();
  if (prefix)
    chapters.push({
      title: "卷首",
      body: prefix,
      volume: "",
      sourceOffset: text.indexOf(prefix),
    });
  let volume = "";
  headings.forEach((heading, index) => {
    const body = text
      .slice(heading.end, headings[index + 1]?.offset ?? text.length)
      .trim();
    if (volumePattern.test(heading.title)) {
      volume = heading.title;
      if (!body) return;
    }
    chapters.push({
      title: heading.title,
      body,
      volume,
      sourceOffset: body ? text.indexOf(body, heading.end) : heading.end,
    });
  });
  return chapters.length
    ? chapters
    : [{ title: "全文", body: text.trim(), volume: "" }];
}

export function decodeBook(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gb18030", { fatal: true }).decode(bytes);
  }
}

export function chapterProgress(chapters, index, fraction) {
  const lengths = chapters.map((chapter) =>
    Math.max(1, chapter.characters ?? chapter.body.length),
  );
  const before = lengths
    .slice(0, index)
    .reduce((sum, length) => sum + length, 0);
  return (
    (before + lengths[index] * Math.max(0, Math.min(1, fraction))) /
    lengths.reduce((sum, length) => sum + length, 0)
  );
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || min));
}

export function palmTypography(width, height, baseSize = 21) {
  const scale = Math.sqrt(
    (Math.max(1, width - 40) * Math.max(1, height - 84)) / (304 * 476),
  );
  return {
    size: Math.round(clamp((16 * scale * baseSize) / 21, 11, 22) * 10) / 10,
    lineHeight: 1.65,
  };
}
