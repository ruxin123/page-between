// Keep the visible PDF and its selectable glyph geometry unchanged.
export async function alignTextLayer(layer, blocks, post, book, page) {
  if (
    !blocks?.some(
      (block) =>
        ["text", "equation", "table"].includes(block.type) && block.text,
    )
  )
    return;
  const revision = (layer._alignmentRevision || 0) + 1;
  layer._alignmentRevision = revision;
  const nodes = [...layer.querySelectorAll("span")].filter(
    (node) =>
      !node.dataset.canonicalObject &&
      node.firstChild?.nodeType === 3 &&
      node.textContent.trim(),
  );
  const rectangle = layer.getBoundingClientRect();
  if (!rectangle.width || !rectangle.height) return;
  const spans = nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return {
      text: node.textContent,
      bbox: [
        (box.left - rectangle.left) / rectangle.width,
        (box.top - rectangle.top) / rectangle.height,
        (box.right - rectangle.left) / rectangle.width,
        (box.bottom - rectangle.top) / rectangle.height,
      ],
    };
  });
  try {
    const { groups } = await post("/api/pdf/align", { book, page, spans });
    if (
      !layer.isConnected ||
      layer._alignmentRevision !== revision ||
      nodes.some((node) => !node.isConnected || !layer.contains(node))
    )
      return;
    const mapped = new Map();
    for (const group of groups) {
      group.nodes = group.spans.map((span) => nodes[span.index]);
      for (const span of group.spans)
        mapped.set(nodes[span.index], { group, map: span.map });
    }
    layer
      .querySelectorAll("[data-canonical-object]")
      .forEach((node) => node.remove());
    for (const group of groups.filter(
      (group) => group.whole && !group.nodes.length,
    )) {
      // OCR can omit every glyph in a table; one transparent character keeps it in the selection order.
      const node = layer.ownerDocument.createElement("span");
      node.dataset.canonicalObject = "true";
      node.textContent = "\uFFFC";
      const [left, top, right, bottom] = group.bbox;
      Object.assign(node.style, {
        left: `${left * 100}%`,
        top: `${top * 100}%`,
        fontSize: `${(bottom - top) * rectangle.height}px`,
        height: `${(bottom - top) * rectangle.height}px`,
        lineHeight: "1",
        userSelect: "all",
      });
      const next =
        nodes.find((item) => mapped.get(item)?.group.order > group.order) ||
        nodes.find(
          (_, index) =>
            spans[index].bbox[1] >= bottom &&
            spans[index].bbox[2] >= left &&
            spans[index].bbox[0] <= right,
        );
      let reference = next;
      while (reference?.parentElement && reference.parentElement !== layer)
        reference = reference.parentElement;
      layer.insertBefore(
        node,
        reference || layer.querySelector(".endOfContent"),
      );
      const width = node.getBoundingClientRect().width;
      if (width)
        node.style.transform = `scaleX(${((right - left) * rectangle.width) / width})`;
      group.nodes = [node];
      mapped.set(node, { group });
    }
    layer._canonical = {
      nodes: [...layer.querySelectorAll("span")].filter(
        (node) => node.firstChild?.nodeType === 3 && node.textContent.trim(),
      ),
      mapped,
    };
  } catch {
    // Uncertain or unavailable alignment leaves the original selection usable.
  }
}

export function mappedFragment(text, map, start, end, math = []) {
  const intervals = [];
  for (let index = start; index < end; index++) {
    if (map[index]) intervals.push(map[index]);
    else if (text[index]?.trim()) return null;
  }
  if (!intervals.length) return null;
  let lo = Math.min(...intervals.map((item) => item[0])),
    hi = Math.max(...intervals.map((item) => item[1]));
  for (const [start, end] of math)
    if (start < hi && end > lo) {
      lo = Math.min(lo, start);
      hi = Math.max(hi, end);
    }
  return [lo, hi];
}

export function canonicalPosition(range, root) {
  for (const layer of root.querySelectorAll(".textLayer")) {
    if (!range.intersectsNode(layer)) continue;
    const model = layer._canonical;
    const nodes =
      model?.nodes ||
      [...layer.querySelectorAll("span")].filter(
        (node) => node.firstChild?.nodeType === 3 && node.textContent.trim(),
      );
    for (const [index, node] of nodes.entries()) {
      if (!range.intersectsNode(node)) continue;
      let start = 0;
      if (node.contains(range.startContainer)) {
        const before = node.ownerDocument.createRange();
        before.selectNodeContents(node);
        before.setEnd(range.startContainer, range.startOffset);
        start = before.toString().length;
      }
      if (start >= node.textContent.length) continue;
      const entry = model?.mapped.get(node);
      const interval =
        entry && !entry.group.whole
          ? mappedFragment(
              node.textContent,
              entry.map,
              start,
              node.textContent.length,
              entry.group.math,
            )
          : null;
      return {
        blockOrder: entry?.group.order ?? -1,
        blockOffset: entry?.group.whole ? 0 : interval?.[0] || 0,
        _textOrdinal: index,
        _textOffset: start,
      };
    }
  }
  return { blockOrder: -1 };
}

export function canonicalSelection(range, root) {
  const pieces = [];
  const emittedObjects = new Set();
  let corrected = false;
  for (const layer of root.querySelectorAll(".textLayer")) {
    const model = layer._canonical;
    if (!range.intersectsNode(layer)) continue;
    const nodes =
      model?.nodes ||
      [...layer.querySelectorAll("span")].filter(
        (node) => node.firstChild?.nodeType === 3 && node.textContent.trim(),
      );
    const selected = [];
    for (const node of nodes) {
      if (!range.intersectsNode(node)) continue;
      const text = node.textContent;
      let start = 0,
        end = text.length;
      if (node.contains(range.startContainer)) {
        const before = node.ownerDocument.createRange();
        before.selectNodeContents(node);
        before.setEnd(range.startContainer, range.startOffset);
        start = before.toString().length;
      }
      if (node.contains(range.endContainer)) {
        const before = node.ownerDocument.createRange();
        before.selectNodeContents(node);
        before.setEnd(range.endContainer, range.endOffset);
        end = before.toString().length;
      }
      if (start < end)
        selected.push({
          node,
          text,
          start,
          end,
          entry: model?.mapped.get(node),
        });
    }
    for (let index = 0; index < selected.length; ) {
      const first = selected[index],
        group = first.entry?.group;
      let last = index + 1;
      while (
        last < selected.length &&
        (group ? selected[last].entry?.group === group : !selected[last].entry)
      )
        last++;
      const items = selected.slice(index, last);
      if (group?.whole) {
        if (!emittedObjects.has(group)) pieces.push(group.text);
        emittedObjects.add(group);
        corrected = true;
        index = last;
        continue;
      }
      const intervals =
        group &&
        items.map((item) =>
          mappedFragment(
            item.text,
            item.entry.map,
            item.start,
            item.end,
            group.math,
          ),
        );
      if (intervals && intervals.every(Boolean)) {
        let lo = Math.min(...intervals.map((item) => item[0])),
          hi = Math.max(...intervals.map((item) => item[1]));
        if (
          first.node === group.nodes[0] &&
          first.start === 0 &&
          items.at(-1).node === group.nodes.at(-1) &&
          items.at(-1).end === items.at(-1).text.length
        ) {
          lo = 0;
          hi = group.text.length;
        }
        pieces.push(group.text.slice(lo, hi));
        corrected = true;
      } else if (layer.dataset.ocrEngine === "tesseract-eng") {
        const fragment = layer.ownerDocument.createRange();
        fragment.setStart(first.node.firstChild, first.start);
        fragment.setEnd(items.at(-1).node.firstChild, items.at(-1).end);
        pieces.push(fragment.toString());
      } else
        pieces.push(
          items.map((item) => item.text.slice(item.start, item.end)).join(" "),
        );
      index = last;
    }
  }
  return corrected ? pieces.join("\n\n").trim() : range.toString().trim();
}
