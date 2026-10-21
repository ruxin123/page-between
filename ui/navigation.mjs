export function flatToc(items) {
  return items.flatMap((item) => [item, ...flatToc(item.children || [])]);
}

export function fragmentTarget(doc, fragment) {
  if (!doc || !fragment) return null;
  return (
    doc.getElementById(fragment) ||
    [...doc.getElementsByName(fragment)].find((node) =>
      doc.body.contains(node),
    ) ||
    null
  );
}

export function epubTocAtAnchor(
  items,
  index,
  { doc, element, offset = 0, fragment } = {},
) {
  const entries = flatToc(items)
    .filter((item) => item.index && item.index <= index)
    .sort((a, b) => a.index - b.index);
  const section = entries.filter((item) => item.index === index);
  const preferred =
    fragment && section.find((item) => item.fragment === fragment);
  if (preferred) return preferred;
  if (!doc || !element) return section[0] || entries.at(-1) || null;
  let active = entries.filter((item) => item.index < index).at(-1) || null;
  for (const item of section) {
    if (!item.fragment) {
      active = item;
      continue;
    }
    const target = fragmentTarget(doc, item.fragment);
    if (!target) continue;
    let reached =
      target === element ||
      target.contains(element) ||
      !!(target.compareDocumentPosition(element) & 4);
    if (element !== target && element.contains(target)) {
      const range = doc.createRange();
      range.selectNodeContents(element);
      range.setEndBefore(target);
      reached = range.toString().length <= offset;
    }
    if (reached) active = item;
  }
  return active;
}
