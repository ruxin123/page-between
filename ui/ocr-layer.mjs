function validBox(box) {
  return (
    Array.isArray(box) &&
    box.length === 4 &&
    box.every(Number.isFinite) &&
    box[2] > box[0] &&
    box[3] > box[1]
  );
}

export function englishLineCells(line) {
  if (!validBox(line.bbox)) return [];
  const glyphs = [];
  for (const item of line.segments?.length
    ? line.segments
    : [{ text: line.text, bbox: line.bbox }]) {
    const text = item.text.trimEnd();
    if (!text || !validBox(item.bbox)) continue;
    const space = item.text.slice(text.length),
      previous = glyphs.at(-1);
    if (
      previous &&
      !previous.space &&
      previous.bbox.every((value, i) => Math.abs(value - item.bbox[i]) < 1e-8)
    ) {
      previous.text += text;
      previous.space = space;
    } else glyphs.push({ text, space, bbox: [...item.bbox] });
  }
  const edges = glyphs.map(({ bbox }) => [bbox[0], bbox[2]]);
  for (let i = 1; i < glyphs.length; i++) {
    const previous = glyphs[i - 1],
      current = glyphs[i];
    if (previous.space) {
      if (edges[i - 1][1] > edges[i][0] && edges[i][0] > edges[i - 1][0])
        edges[i - 1][1] = edges[i][0];
      continue;
    }
    const leftCenter = (previous.bbox[0] + previous.bbox[2]) / 2,
      rightCenter = (current.bbox[0] + current.bbox[2]) / 2;
    if (rightCenter <= leftCenter) continue;
    const boundary = Math.max(
      leftCenter,
      Math.min(rightCenter, (previous.bbox[2] + current.bbox[0]) / 2),
    );
    edges[i - 1][1] = boundary;
    edges[i][0] = boundary;
  }
  const cells = [];
  for (const [i, glyph] of glyphs.entries()) {
    cells.push({
      text: glyph.text,
      bbox: [edges[i][0], line.bbox[1], edges[i][1], line.bbox[3]],
    });
    if (glyph.space && i + 1 < glyphs.length) {
      const left = edges[i][1];
      cells.push({
        text: glyph.space,
        bbox: [
          left,
          line.bbox[1],
          Math.max(left + 1e-7, edges[i + 1][0]),
          line.bbox[3],
        ],
      });
    }
  }
  return cells;
}

export function renderOcrLayer(root, data, viewport, language) {
  delete root._canonical;
  root.replaceChildren();
  root.lang = language;
  root.dataset.ocrEngine = data.engine;
  const measure = root.ownerDocument.createElement("canvas").getContext("2d"),
    english = data.engine === "tesseract-eng",
    family = language?.startsWith("zh")
      ? "Songti SC, serif"
      : "Times New Roman, serif";
  for (const [index, line] of data.lines.entries()) {
    const cells = english
      ? englishLineCells(line)
      : line.segments?.length
        ? line.segments
        : [{ text: line.text, bbox: line.bbox }];
    const row = english ? root.ownerDocument.createElement("div") : root;
    let previousRight = 0;
    if (english) {
      // Inline cells retain the native anchor when a drag crosses character and word boundaries.
      Object.assign(row.style, {
        position: "absolute",
        left: "0",
        top: `${line.bbox[1] * viewport.height}px`,
        width: "100%",
        height: `${(line.bbox[3] - line.bbox[1]) * viewport.height}px`,
        whiteSpace: "pre",
        fontSize: "0",
        lineHeight: "0",
      });
      root.append(row);
    }
    for (const cell of cells) {
      if (!validBox(cell.bbox)) continue;
      const [x0, y0, x1, y1] = cell.bbox,
        span = root.ownerDocument.createElement("span"),
        height = (y1 - y0) * viewport.height;
      span.textContent = cell.text;
      span.dataset.ocrLine = index;
      measure.font = `${height}px ${family}`;
      const width = Math.max(
        english ? 0.01 : 1,
        measure.measureText(english ? cell.text : cell.text.trimEnd()).width,
      );
      Object.assign(span.style, {
        left: `${x0 * viewport.width}px`,
        top: `${y0 * viewport.height}px`,
        fontSize: `${height}px`,
        height: `${height}px`,
        width: `${width}px`,
        fontFamily: family,
        transform: `scaleX(${((x1 - x0) * viewport.width) / width})`,
      });
      if (english) {
        const cellBox = root.ownerDocument.createElement("div");
        Object.assign(cellBox.style, {
          display: "inline-block",
          verticalAlign: "top",
          overflow: "clip",
          width: `${(x1 - x0) * viewport.width}px`,
          height: `${height}px`,
          marginLeft: `${(x0 - previousRight) * viewport.width}px`,
        });
        Object.assign(span.style, {
          position: "relative",
          display: "inline-block",
          left: "0",
          top: "0",
          lineHeight: "1",
        });
        cellBox.append(span);
        row.append(cellBox);
        previousRight = x1;
      } else root.append(span);
    }
    if (english) row.append(root.ownerDocument.createTextNode("\n"));
    else root.append(root.ownerDocument.createElement("br"));
  }
}

export function ocrTextUnits(layer) {
  const nodes = [...layer.querySelectorAll("span")].filter(
    (node) => node.firstChild?.nodeType === 3 && node.textContent.trim(),
  );
  return nodes.map((node, i) => {
    const range = layer.ownerDocument.createRange();
    range.setStart(node.firstChild, 0);
    if (nodes[i + 1]) range.setEndBefore(nodes[i + 1]);
    else range.setEndAfter(node);
    return range.toString();
  });
}
