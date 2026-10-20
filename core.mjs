const headingPattern =
  /^(?:第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[章节回卷部篇](?:\s|[：:、.．—-]|$).*|(?:chapter|part|book)\s+(?:\d+|[ivxlcdm]+)(?:\s|[.:—-]|$).*|(?:序章|序言|前言|引子|楔子|尾声|后记|终章)(?:\s|[：:、—-]|$).*)$/iu;
const volumePattern =
  /^(?:第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[卷部篇]|(?:part|book)\s)/iu;
const compactHeadingPattern =
  /^第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[章节回卷部篇]\S.{0,35}$/u;

export function shouldFollowPosition({
  revision,
  seen,
  remote,
  local,
  allowed,
}) {
  return !!(
    allowed &&
    revision >= seen &&
    remote?.updatedAt > (local?.updatedAt || 0)
  );
}

export function textChapterIndex(chapters, offset) {
  if (!Number.isFinite(offset)) return 1;
  return Math.max(
    1,
    chapters.findLastIndex((chapter) => (chapter.sourceOffset || 0) <= offset) +
      1,
  );
}

export function sliceText(text, start, end = text.length) {
  start = Math.max(0, Math.min(text.length, start));
  end = Math.max(start, Math.min(text.length, end));
  if (start === end) return "";
  const high = (value) => value >= 0xd800 && value <= 0xdbff;
  const low = (value) => value >= 0xdc00 && value <= 0xdfff;
  if (low(text.charCodeAt(start)) && high(text.charCodeAt(start - 1))) start--;
  if (high(text.charCodeAt(end - 1)) && low(text.charCodeAt(end))) end++;
  return text.slice(start, end);
}

export function parseChapters(input) {
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n"),
    candidates = [];
  let offset = 0;
  for (const [number, line] of lines.entries()) {
    const title = line.trim();
    const strict = title.length <= 80 && headingPattern.test(title);
    const compact =
      title.length <= 40 &&
      compactHeadingPattern.test(title) &&
      !/[。！？!?；;]/u.test(title);
    if (strict || compact)
      candidates.push({
        title,
        offset,
        end: offset + line.length,
        compact: !strict,
        isolated: !lines[number - 1]?.trim() || !lines[number + 1]?.trim(),
      });
    offset += line.length + 1;
  }
  const compactCount = candidates.filter((item) => item.compact).length;
  const headings = candidates.filter(
    (item) => !item.compact || item.isolated || compactCount >= 2,
  );
  const full = {
    title: "全文",
    body: text.trim(),
    volume: "",
    sourceOffset: text.indexOf(text.trim()),
    sourceEnd: text.indexOf(text.trim()) + text.trim().length,
  };
  if (!headings.length) return [full];
  const chapters = [];
  const prefix = text.slice(0, headings[0].offset).trim();
  if (prefix)
    chapters.push({
      title: "卷首",
      body: prefix,
      volume: "",
      sourceOffset: text.indexOf(prefix),
      sourceEnd: text.indexOf(prefix) + prefix.length,
    });
  let volume = "";
  const bodies = headings.map((heading, index) =>
    text.slice(heading.end, headings[index + 1]?.offset ?? text.length).trim(),
  );
  const lastWithBody = new Map();
  headings.forEach((heading, index) => {
    if (bodies[index]) lastWithBody.set(heading.title, index);
  });
  headings.forEach((heading, index) => {
    const body = bodies[index];
    if (!body && lastWithBody.get(heading.title) > index) return;
    if (volumePattern.test(heading.title)) {
      volume = heading.title;
      if (!body) return;
    }
    const sourceOffset = body ? text.indexOf(body, heading.end) : heading.end;
    chapters.push({
      title: heading.title,
      body,
      volume,
      sourceOffset,
      sourceEnd: sourceOffset + body.length,
    });
  });
  return chapters.length ? chapters : [full];
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
